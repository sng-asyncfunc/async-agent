# Homebrew cask sketch for Async Agent (Rust + Bun).
#
# Living draft: a cask is only installable once a public release or tap exists.
# The sha256 stanzas are refreshed per release from SHA256SUMS.
cask "async-agent" do
  version "0.1.0"
  sha256 arm:   "<sha256 from SHA256SUMS>",
         x86_64: "<sha256 from SHA256SUMS>"

  on_arm do
    url "https://github.com/sng-asyncfunc/async-agent/releases/download/v#{version}/async-agent-#{version}-aarch64-apple-darwin.tar.gz"
  end
  on_intel do
    url "https://github.com/sng-asyncfunc/async-agent/releases/download/v#{version}/async-agent-#{version}-x86_64-apple-darwin.tar.gz"
  end

  name "Async Agent"
  desc "Bun-native JavaScript RLM agent harness"
  homepage "https://github.com/sng-asyncfunc/async-agent"

  livecheck do
    url :url
    regex(/async-agent-v?(\d+(?:\.\d+)*)-aarch64-apple-darwin\.tar\.gz/i)
  end

  # `binary` symlinks into PATH; the binary resolves its package dir from the
  # real executable path (current_exe follows the symlink), so the bundled
  # async-agent-runtime/ and skills/ next to it in the caskroom just work.
  binary "async-agent"

  zap trash: [
    "~/.async-agent", # sessions, subagents, skills, harness state, kernel-bun
  ]
end
