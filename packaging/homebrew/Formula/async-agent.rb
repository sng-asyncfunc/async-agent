# Homebrew formula candidate for async-agent (Rust + Bun).
#
# Distributed as a source tarball (async-agent-<version>-src.tar.gz: the git
# tree at the tag plus the bundled catalog assets at the archive root — see
# scripts/release/assemble_source.py and the assemble step in
# .github/workflows/release.yml), which this formula builds with cargo.
# The cask sketch next door (packaging/homebrew/Casks/async-agent.rb) is
# the vendor-tap alternative (prebuilt binaries).
#
# Submission note: the sha256 below is a placeholder, filled from the
# release's SHA256SUMS when the tag publishes.
class AsyncAgent < Formula
  desc "Coding agent harness with a persistent Bun JavaScript control environment"
  homepage "https://github.com/sng-asyncfunc/async-agent"
  url "https://github.com/sng-asyncfunc/async-agent/releases/download/v0.10.5/async-agent-0.10.5-src.tar.gz"
  # TODO: replace with the release src-tarball sha256 from the release SHA256SUMS
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"

  livecheck do
    url "https://github.com/sng-asyncfunc/async-agent/releases/latest"
    # Stable releases only: the beta cuts (-beta.N) build no source tarball.
    regex(/async-agent-v?(\d+(?:\.\d+)+)-src\.tar\.gz/i)
  end

  depends_on "rust" => :build
  # The binary runs its persistent JavaScript REPL through Bun (>= 1.3.14).
  depends_on "oven-sh/bun/bun"

  def install
    system "cargo", "build", "--release", "--locked"
    # The shipped payload set (assemble_artifacts.py STAGED_ENTRIES): the
    # binary plus the kernel runtime, skills, and the bundled catalog
    # assets it resolves beside its executable.
    libexec.install "target/release/async-agent"
    libexec.install "async-agent-runtime", "skills"
    libexec.install "models.bundled.json", "mcp-services.bundled.json"
    libexec.install "LICENSE", "README.md"
    bin.install_symlink libexec/"async-agent"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/async-agent --version")
  end
end
