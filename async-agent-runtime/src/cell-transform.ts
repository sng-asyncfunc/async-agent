import {
	type ClassDeclaration,
	type FunctionDeclaration,
	type ImportDeclaration,
	type ModuleDeclaration,
	type Pattern,
	type Program,
	parse,
	type ReturnStatement,
	type Statement,
	type VariableDeclaration,
} from "acorn";

export interface TransformedJavaScriptCell {
	code: string;
	bindingNames: string[];
	bindingRecipes: Record<string, ModuleBindingRecipe>;
}

export interface ModuleBindingRecipe {
	type: "module";
	loader: "import" | "require";
	specifier: string;
	exportName?: string;
}

interface BindingPersistence {
	name: string;
	recipe?: ModuleBindingRecipe;
}

interface SourceEdit {
	start: number;
	end: number;
	text: string;
}

const tsStripper = new Bun.Transpiler({ deadCodeElimination: false, loader: "ts", target: "bun" });
const replTranspiler = new Bun.Transpiler({
	deadCodeElimination: false,
	loader: "js",
	replMode: true,
	target: "bun",
});
const BUN_REQUIRE_SHIM = "var {require}=import.meta;";

function stripBunRequireShim(code: string): string {
	return code.startsWith(BUN_REQUIRE_SHIM) ? code.slice(BUN_REQUIRE_SHIM.length) : code;
}

function stripTypeScriptForCell(rawSource: string): string {
	// Bare object literals like `{ a: 1 }`, `{ a: 1, b: 2 }`, `{ prompt, self, x }`,
	// or `{ a: 1 as number, b: 2 }` would otherwise be parsed as BlockStatements
	// (labeled/comma statements) or syntax errors at module statement position.
	// Try parenthesizing first; real blocks like `{ const y = 1; y; }` fail to
	// parse as parenthesized expressions and fall through cleanly.
	const trimmed = rawSource.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		try {
			return stripBunRequireShim(tsStripper.transformSync(`(${trimmed})`));
		} catch {
			// Not an object literal; fall through to standard TS stripping.
		}
	}
	return stripBunRequireShim(tsStripper.transformSync(rawSource));
}

function collectPatternBindings(pattern: Pattern, names: string[]): void {
	switch (pattern.type) {
		case "Identifier":
			names.push(pattern.name);
			return;
		case "ObjectPattern":
			for (const property of pattern.properties) {
				collectPatternBindings(property.type === "RestElement" ? property.argument : property.value, names);
			}
			return;
		case "ArrayPattern":
			for (const element of pattern.elements) {
				if (element) collectPatternBindings(element, names);
			}
			return;
		case "RestElement":
			collectPatternBindings(pattern.argument, names);
			return;
		case "AssignmentPattern":
			collectPatternBindings(pattern.left, names);
			return;
		case "MemberExpression":
			return;
	}
}

function declarationBindings(declaration: VariableDeclaration | FunctionDeclaration | ClassDeclaration): string[] {
	if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
		return [declaration.id.name];
	}
	const names: string[] = [];
	for (const declarator of declaration.declarations) {
		collectPatternBindings(declarator.id, names);
	}
	return names;
}

function literalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function objectPatternBinding(pattern: Pattern): string | undefined {
	if (pattern.type === "Identifier") return pattern.name;
	if (pattern.type === "AssignmentPattern" && pattern.left.type === "Identifier") return pattern.left.name;
	return undefined;
}

function recordObjectPatternRecipes(
	pattern: Extract<Pattern, { type: "ObjectPattern" }>,
	loader: ModuleBindingRecipe["loader"],
	specifier: string,
	recipes: Record<string, ModuleBindingRecipe>,
): void {
	for (const property of pattern.properties) {
		if (property.type === "RestElement" || property.computed) continue;
		const exportName =
			property.key.type === "Identifier"
				? property.key.name
				: property.key.type === "Literal"
					? literalString(property.key.value)
					: undefined;
		const localName = objectPatternBinding(property.value);
		if (!exportName || !localName) continue;
		recipes[localName] = { exportName, loader, specifier, type: "module" };
	}
}

function literalModuleRecipes(declaration: VariableDeclaration): Record<string, ModuleBindingRecipe> {
	const recipes: Record<string, ModuleBindingRecipe> = {};
	for (const declarator of declaration.declarations) {
		const initializer = declarator.init;
		if (!initializer) continue;
		if (initializer.type === "AwaitExpression") {
			let specifier: string | undefined;
			if (initializer.argument.type === "ImportExpression") {
				specifier =
					initializer.argument.source.type === "Literal"
						? literalString(initializer.argument.source.value)
						: undefined;
			} else if (
				initializer.argument.type === "CallExpression" &&
				initializer.argument.callee.type === "Identifier" &&
				initializer.argument.callee.name === "__asyncImportModule" &&
				initializer.argument.arguments.length >= 1 &&
				initializer.argument.arguments[0]?.type === "Literal"
			) {
				specifier = literalString(initializer.argument.arguments[0].value);
			}
			if (!specifier) continue;
			if (declarator.id.type === "Identifier") {
				recipes[declarator.id.name] = { loader: "import", specifier, type: "module" };
				continue;
			}
			if (declarator.id.type === "ObjectPattern") {
				recordObjectPatternRecipes(declarator.id, "import", specifier, recipes);
			}
			continue;
		}
		if (
			initializer.type !== "CallExpression" ||
			initializer.callee.type !== "Identifier" ||
			initializer.callee.name !== "require" ||
			initializer.arguments.length !== 1
		) {
			continue;
		}
		const argument = initializer.arguments[0];
		if (!argument || argument.type !== "Literal") continue;
		const specifier = literalString(argument.value);
		if (!specifier) continue;
		if (declarator.id.type === "Identifier") {
			recipes[declarator.id.name] = { loader: "require", specifier, type: "module" };
		} else if (declarator.id.type === "ObjectPattern") {
			recordObjectPatternRecipes(declarator.id, "require", specifier, recipes);
		}
	}
	return recipes;
}

function importedBindingExpression(namespace: string, exportName: string, specifier: string): string {
	const key = JSON.stringify(exportName);
	const message = JSON.stringify(`Module ${specifier} does not export ${exportName}`);
	return `(${key} in ${namespace} ? ${namespace}[${key}] : (() => { throw new SyntaxError(${message}); })())`;
}

function lowerImportDeclaration(
	declaration: ImportDeclaration,
	namespace: string,
): { code: string; bindings: BindingPersistence[] } {
	const specifier = literalString(declaration.source.value);
	if (!specifier) throw new SyntaxError("Static import specifiers must be string literals.");
	if (declaration.attributes.length > 0) {
		throw new SyntaxError("Static import attributes are not supported in Bun cells.");
	}
	if (declaration.specifiers.length === 0) {
		return { code: `await __asyncImportModule(${JSON.stringify(specifier)});`, bindings: [] };
	}

	const declNames: string[] = [];
	const assignments: string[] = [];
	const bindings: BindingPersistence[] = [];
	for (const importSpecifier of declaration.specifiers) {
		const name = importSpecifier.local.name;
		let exportName: string | undefined;
		switch (importSpecifier.type) {
			case "ImportDefaultSpecifier":
				exportName = "default";
				break;
			case "ImportNamespaceSpecifier":
				break;
			case "ImportSpecifier":
				exportName =
					importSpecifier.imported.type === "Identifier"
						? importSpecifier.imported.name
						: literalString(importSpecifier.imported.value);
				if (!exportName) throw new SyntaxError("Static import names must be strings.");
				break;
		}
		const recipe: ModuleBindingRecipe = {
			...(exportName ? { exportName } : {}),
			loader: "import",
			specifier,
			type: "module",
		};
		declNames.push(name);
		assignments.push(
			`${name} = ${exportName ? importedBindingExpression(namespace, exportName, specifier) : namespace};`,
		);
		bindings.push({ name, recipe });
	}

	// Keep the temporary module namespace block-scoped inside `{ ... }` so
	// Bun's `replMode` only hoists the user's declared import bindings onto
	// `globalThis` and never leaks temporary namespace variables.
	const code = [
		`let ${declNames.join(", ")};`,
		"{",
		`const ${namespace} = await __asyncImportModule(${JSON.stringify(specifier)});`,
		...assignments,
		"}",
	].join("\n");
	return { code, bindings };
}

function privateImportNamespace(
	source: string,
	index: number,
	generatedNames: Set<string>,
	checkSourceCollision: boolean,
): string {
	let name = `__asyncImport${index}`;
	if (checkSourceCollision || generatedNames.size > 0) {
		while ((checkSourceCollision && source.includes(name)) || generatedNames.has(name)) name += "_";
	}
	generatedNames.add(name);
	return name;
}

function applyEdits(source: string, edits: SourceEdit[]): string {
	const count = edits.length;
	if (count === 0) return source;
	if (count === 1) {
		const edit = edits[0]!;
		return `${source.slice(0, edit.start)}${edit.text}${source.slice(edit.end)}`;
	}
	// Preserve exact reverse-order semantics for identical (start, end) insertions
	// while assembling the output in a single O(N) forward pass.
	const indexed = new Array<{ start: number; end: number; text: string; order: number }>(count);
	for (let i = 0; i < count; i += 1) {
		const edit = edits[i]!;
		indexed[i] = { start: edit.start, end: edit.end, text: edit.text, order: i };
	}
	indexed.sort((left, right) => left.start - right.start || left.end - right.end || right.order - left.order);
	const parts = new Array<string>(count * 2 + 1);
	let cursor = 0;
	let outIdx = 0;
	for (let i = 0; i < count; i += 1) {
		const edit = indexed[i]!;
		parts[outIdx++] = source.slice(cursor, edit.start);
		parts[outIdx++] = edit.text;
		cursor = edit.end;
	}
	parts[outIdx] = source.slice(cursor);
	return parts.join("");
}

function parseCell(source: string): Program {
	return parse(source, {
		allowAwaitOutsideFunction: true,
		allowReturnOutsideFunction: true,
		ecmaVersion: "latest",
		sourceType: "module",
	});
}

function collectNotebookReturnStatements(statement: Statement | ModuleDeclaration, returns: ReturnStatement[]): void {
	switch (statement.type) {
		case "ReturnStatement":
			returns.push(statement);
			return;
		case "BlockStatement":
			for (const child of statement.body) collectNotebookReturnStatements(child, returns);
			return;
		case "WithStatement":
		case "LabeledStatement":
		case "WhileStatement":
		case "DoWhileStatement":
		case "ForStatement":
		case "ForInStatement":
		case "ForOfStatement":
			collectNotebookReturnStatements(statement.body, returns);
			return;
		case "IfStatement":
			collectNotebookReturnStatements(statement.consequent, returns);
			if (statement.alternate) collectNotebookReturnStatements(statement.alternate, returns);
			return;
		case "SwitchStatement":
			for (const switchCase of statement.cases) {
				for (const child of switchCase.consequent) collectNotebookReturnStatements(child, returns);
			}
			return;
		case "TryStatement":
			collectNotebookReturnStatements(statement.block, returns);
			if (statement.handler) collectNotebookReturnStatements(statement.handler.body, returns);
			if (statement.finalizer) collectNotebookReturnStatements(statement.finalizer, returns);
			return;
		default:
			return;
	}
}

function collectDynamicImportEdits(node: unknown, source: string, edits: SourceEdit[]): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) collectDynamicImportEdits(item, source, edits);
		return;
	}
	const record = node as Record<string, unknown>;
	if (record.type === "ImportExpression" && typeof record.start === "number" && record.source) {
		const srcNode = record.source as { start: number };
		const prefix = source.slice(record.start, srcNode.start);
		const importIdx = prefix.indexOf("import");
		if (importIdx >= 0) {
			edits.push({
				start: record.start + importIdx,
				end: record.start + importIdx + "import".length,
				text: "__asyncImportModule",
			});
		}
	}
	for (const key of Object.keys(record)) {
		if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
		const child = record[key];
		if (child && typeof child === "object") collectDynamicImportEdits(child, source, edits);
	}
}

export function transformJavaScriptCell(rawSource: string): TransformedJavaScriptCell {
	let source = stripTypeScriptForCell(rawSource);
	let program = parseCell(source);
	if (program.body.length === 0) {
		return { code: "", bindingNames: [], bindingRecipes: {} };
	}

	if (source.includes("import")) {
		const dynamicImportEdits: SourceEdit[] = [];
		collectDynamicImportEdits(program, source, dynamicImportEdits);
		if (dynamicImportEdits.length > 0) {
			source = applyEdits(source, dynamicImportEdits);
			program = parseCell(source);
		}
	}

	const edits: SourceEdit[] = [];
	const bindingNames: string[] = [];
	const bindingRecipes: Record<string, ModuleBindingRecipe> = {};
	const generatedImportNames = new Set<string>();
	const checkImportCollision = source.includes("__asyncImport");
	let importIndex = 0;
	let returnLabelPrefix = "__asyncRet";
	while (source.includes(returnLabelPrefix)) returnLabelPrefix += "_";
	let returnIndex = 0;
	const topLevelReturns: ReturnStatement[] = [];

	for (const statement of program.body) {
		collectNotebookReturnStatements(statement, topLevelReturns);
		switch (statement.type) {
			case "ImportDeclaration": {
				const namespace = privateImportNamespace(source, importIndex, generatedImportNames, checkImportCollision);
				const lowered = lowerImportDeclaration(statement, namespace);
				importIndex += 1;
				bindingNames.push(...lowered.bindings.map(({ name }) => name));
				for (const binding of lowered.bindings) {
					if (binding.recipe) bindingRecipes[binding.name] = binding.recipe;
				}
				edits.push({
					start: statement.start,
					end: statement.end,
					text: lowered.code,
				});
				break;
			}
			case "ExportNamedDeclaration":
			case "ExportDefaultDeclaration":
			case "ExportAllDeclaration":
				throw new SyntaxError("Exports are not supported in Bun cells.");
			case "VariableDeclaration": {
				const names = declarationBindings(statement);
				const recipes = literalModuleRecipes(statement);
				bindingNames.push(...names);
				Object.assign(bindingRecipes, recipes);
				// Ensure uninitialized `let x;` / `var x;` still assigns `undefined`
				// on `globalThis` once the leading `var` hoist preamble is stripped.
				for (const declarator of statement.declarations) {
					if (!declarator.init && declarator.id.type === "Identifier") {
						edits.push({ start: declarator.id.end, end: declarator.id.end, text: " = void 0" });
					}
				}
				break;
			}
			case "FunctionDeclaration":
			case "ClassDeclaration": {
				const names = declarationBindings(statement);
				bindingNames.push(...names);
				break;
			}
		}
	}

	// Bun's `replMode` rejects top-level `return` when the same cell also uses
	// top-level `await` (treating the cell as an ES module). Rewrite top-level
	// `return` statements to unique labeled statements before `replMode`, then
	// restore `return ` (consuming any line break to avoid ASI) inside the
	// generated IIFE.
	for (const returnStatement of topLevelReturns) {
		const label = `${returnLabelPrefix}${returnIndex++}`;
		const arg = returnStatement.argument
			? `(${source.slice(returnStatement.argument.start, returnStatement.argument.end)})`
			: "void 0";
		edits.push({
			start: returnStatement.start,
			end: returnStatement.end,
			text: `${label}: ${arg};`,
		});
	}

	let prepared = applyEdits(source, edits);
	const finalStatement = program.body.at(-1);
	// Suppress Bun `replMode`'s implicit completion value for declaration/control
	// cells (e.g. `const data = hugeArray;`) so assigning to a variable does not
	// echo or spill the assigned value, while explicit `return` and trailing
	// expressions still return their values.
	if (finalStatement && finalStatement.type !== "ExpressionStatement" && finalStatement.type !== "ReturnStatement") {
		prepared = `${prepared}\n;void 0;`;
	}

	let replCode = stripBunRequireShim(replTranspiler.transformSync(prepared));
	// Strip Bun `replMode`'s top-level `var ...;` hoist preamble so bindings are
	// assigned onto `globalThis` as `configurable: true` properties and can be
	// cleanly deleted by `prune_oversized` snapshots to release heap memory.
	replCode = replCode.replace(/^(?:var [^;\n]+;\n)+/, "");
	if (returnIndex > 0) {
		const restoreReturnPattern = new RegExp(`\\b${returnLabelPrefix}\\d+:\\s*`, "g");
		replCode = replCode.replace(restoreReturnPattern, "return ");
	}
	return {
		code: replCode,
		bindingNames,
		bindingRecipes,
	};
}
