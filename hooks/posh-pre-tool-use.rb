# JSON parsing belongs in Ruby's standard library, not shell regexes. No gems required.
require "json"
require "open3"
require "fileutils"
require "shellwords"
require "uri"
require "rubygems"

def lookup_for_path(path)
  path = File.expand_path(path)
  installed = path.match?(%r{/(?:vendor/bundle|ruby/gems|gems/\d+\.\d+(?:\.\d+)?|\.gem/(?:ruby|jruby)/[^/]+)(?:/|\z)}) ||
    Gem.path.any? { |home| path == home || path == "#{home}/gems" || path.start_with?("#{home}/gems/") }
  return unless installed

  match = path.match(%r{/gems/([a-zA-Z0-9_.-]+)-[0-9][0-9a-zA-Z.]*})
  match ? "gem:#{match[1]}" : :gem_tree
end

def lookup_for_url(url)
  uri = URI.parse(url)
  return unless %w[http https].include?(uri.scheme)

  match = case uri.host&.downcase
  when "rubydoc.info", "www.rubydoc.info", "rubygems.org", "www.rubygems.org"
    uri.path.match(%r{\A/gems/([a-zA-Z0-9_.-]+)(?:/|\z)}) ||
      uri.path.match(%r{\A/downloads/([a-zA-Z0-9_.-]+)-[0-9][0-9a-zA-Z.]*\.gem\z})
  when "api.rubyonrails.org", "guides.rubyonrails.org"
    return "gem:rails"
  # shortcut: repository names are only a hint, not a gem-to-repository map;
  # add metadata matching if real transcripts show differently named repos being missed.
  when "github.com"
    uri.path.match(%r{\A/[a-zA-Z0-9_.-]+/([a-zA-Z0-9_.-]+)/(?:blob|raw)/})
  when "raw.githubusercontent.com"
    uri.path.match(%r{\A/[a-zA-Z0-9_.-]+/([a-zA-Z0-9_.-]+)/})
  end
  "gem:#{match[1]}" if match
rescue URI::InvalidURIError
  nil
end

def lookup_for_command(command)
  # shortcut: tokenize common commands, not arbitrary shell syntax;
  # extend from observed misses rather than adding a shell parser.
  words = Shellwords.split(command)
  words.each_cons(3) do |tool, action, name|
    if ((tool == "gem" && %w[contents which unpack].include?(action)) ||
        (tool == "bundle" && %w[show open].include?(action))) && name.match?(/\A[a-zA-Z0-9_][a-zA-Z0-9_.-]*\z/)
      return "gem:#{name}"
    end
  end
  if words.any? { |word| %w[curl wget].include?(word) }
    words.each do |word|
      lookup = lookup_for_url(word)
      return lookup if lookup
    end
  end
  if words.any? { |word| %w[cat sed grep rg find ls head tail awk cd].include?(word) }
    words.each do |word|
      lookup = lookup_for_path(word)
      return lookup if lookup
    end
  end
end

begin
  input = JSON.parse($stdin.read)
  exit 0 unless input.is_a?(Hash) && input["tool_input"].is_a?(Hash)

  cwd = input["cwd"]
  session = input["session_id"]
  exit 0 unless cwd.is_a?(String) && File.directory?(cwd)
  exit 0 unless session.is_a?(String) && session.match?(/\A[a-zA-Z0-9_-]+\z/)
  cwd = File.realpath(cwd)
  project = File.realpath(ARGV.fetch(0))
  exit 0 unless cwd == project || cwd.start_with?("#{project}/")

  args = input["tool_input"]
  lookup = case input["tool_name"]
  when "Read"
    lookup_for_path(args.fetch("file_path"))
  when "Grep"
    lookup_for_path(args.fetch("path", cwd))
  when "Glob"
    lookup_for_path(File.join(args.fetch("path", cwd), args.fetch("pattern")))
  when "WebFetch"
    lookup_for_url(args.fetch("url"))
  when "Bash"
    lookup_for_command(args.fetch("command"))
  end
  exit 0 unless lookup
  ref = lookup == :gem_tree ? nil : lookup

  state = ENV["CLAUDE_PLUGIN_DATA"] || File.join(ENV.fetch("XDG_CACHE_HOME", File.join(Dir.home, ".cache")), "posh")
  marker = File.join(state, "nudged", "#{session}.#{ref || 'gem-tree'}")
  exit 0 if File.exist?(marker)

  command = ["posh", "docsets", "--json", "--project", project]
  command += ["--filter", ref] if ref
  stdout, _stderr, status = Open3.capture3(*command)
  exit 0 unless status.success?

  docs = JSON.parse(stdout)
  exit 0 unless docs.is_a?(Hash) && docs["ok"] == true && docs["data"].is_a?(Array)
  exit 0 unless File.realpath(docs.fetch("project_path")) == File.realpath(project)

  library = docs["data"].find do |row|
    row.is_a?(Hash) && row["ref"].is_a?(String) && row["ref"].start_with?("gem:") &&
      (!ref || row["ref"] == ref) &&
      row["kinds"].is_a?(Array) && !row["kinds"].empty?
  end
  exit 0 unless library

  # Claim atomically: parallel calls get at most one nudge. If state cannot be saved,
  # fail open rather than denying the same call forever.
  FileUtils.mkdir_p(File.dirname(marker))
  Dir.mkdir(marker)

  subject = ref ? "#{ref} #{library['version']}, the version this project locks" : "the installed source of the gems this project locks"
  query = { query: "<symbol or page name>", project: project }
  query[:ref] = ref if ref
  read = { ref: "<returned document ref>", project: project }
  cli = "posh search '<symbol>'"
  cli += " --ref #{ref}" if ref
  cli += " --project #{Shellwords.escape(project)}"
  reason = <<~TEXT
    POSH has local documentation for #{subject}.

    Use POSH's search tool with #{JSON.generate(query)}, or `#{cli}`, then read the returned document ref using #{JSON.generate(read)}. For CLI reads, keep the same --project argument. Search for README or CHANGELOG for those pages.

    This redirect fires once per gem per session. If POSH cannot answer, retry the original call; it will go through. Source inspection remains available for implementation details and debugging.
  TEXT
  puts JSON.generate(hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: ENV["POSH_HOOK_DECISION"] == "ask" ? "ask" : "deny",
    permissionDecisionReason: reason
  })
rescue StandardError
  # Invalid input, unavailable POSH, or unwritable state must never block real work.
end
