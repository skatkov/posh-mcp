# JSON parsing belongs in Ruby's standard library, not shell regexes. No gems required.
require "json"
require "open3"
require "fileutils"
require "shellwords"

def gem_ref(target, source: true)
  if source
    match = target.match(%r{(?:\A|/)gems/([a-zA-Z0-9_.-]+)-[0-9][0-9a-zA-Z.]*})
    return match[1] if match
  end

  case target
  when %r{https?://(?:www\.)?(?:rubydoc\.info|rubygems\.org)/gems/([a-zA-Z0-9_.-]+)}
    return Regexp.last_match(1)
  when %r{https?://rubygems\.org/downloads/([a-zA-Z0-9_.-]+)-[0-9][0-9a-zA-Z.]*\.gem}
    return Regexp.last_match(1)
  when %r{https?://(?:api|guides)\.rubyonrails\.org(?:/|\z)}
    return "rails"
  when %r{https?://github\.com/[a-zA-Z0-9_.-]+/([a-zA-Z0-9_.-]+)/(?:blob|raw)/},
       %r{https?://raw\.githubusercontent\.com/[a-zA-Z0-9_.-]+/([a-zA-Z0-9_.-]+)/}
    return Regexp.last_match(1)
  end

  # shortcut: repository names are only a hint, not a gem-to-repository map;
  # add metadata matching if real transcripts show differently named repos being missed.
  return "_gem_root" if source && target.match?(%r{(?:\A|/)vendor/bundle(?:/|\z)|/gems(?:/|\z)})
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
  gem = case input["tool_name"]
  when "Read"
    gem_ref(args.fetch("file_path"))
  when "Grep"
    gem_ref(args.fetch("path", cwd))
  when "Glob"
    gem_ref(File.join(args.fetch("path", cwd), args.fetch("pattern")))
  when "WebFetch"
    gem_ref(args.fetch("url"), source: false)
  when "Bash"
    command = args.fetch("command")
    # shortcut: recognize common source-reading commands, not arbitrary shell programs;
    # extend from observed misses rather than trying to parse the shell.
    match = command.match(/(?:\A|[\s;&|])(?:gem\s+(?:contents|which|unpack)|bundle\s+(?:show|open))\s+["']?([a-zA-Z0-9_][a-zA-Z0-9_.-]*)/)
    match ? match[1] : gem_ref(command, source: command.match?(/(?:\A|[\s;&|])(?:cat|sed|grep|rg|find|ls|head|tail|awk|cd)\s/))
  end
  exit 0 unless gem

  state = ENV["CLAUDE_PLUGIN_DATA"] || File.join(ENV.fetch("XDG_CACHE_HOME", File.join(Dir.home, ".cache")), "posh")
  marker = File.join(state, "nudged", "#{session}.#{gem}")
  exit 0 if File.exist?(marker)

  command = ["posh", "docsets", "--json", "--project", project]
  command += ["--filter", "gem:#{gem}"] unless gem == "_gem_root"
  stdout, _stderr, status = Open3.capture3(*command)
  exit 0 unless status.success?

  docs = JSON.parse(stdout)
  exit 0 unless docs.is_a?(Hash) && docs["ok"] == true && docs["data"].is_a?(Array)
  exit 0 unless File.realpath(docs.fetch("project_path")) == File.realpath(project)

  library = docs["data"].find do |row|
    row.is_a?(Hash) && row["ref"].is_a?(String) && row["ref"].start_with?("gem:") &&
      (gem == "_gem_root" || row["ref"] == "gem:#{gem}") &&
      row["kinds"].is_a?(Array) && !row["kinds"].empty?
  end
  exit 0 unless library

  # Claim atomically: parallel calls get at most one nudge. If state cannot be saved,
  # fail open rather than denying the same call forever.
  FileUtils.mkdir_p(File.dirname(marker))
  Dir.mkdir(marker)

  subject = gem == "_gem_root" ? "the installed source of the gems this project locks" : "#{library['ref']} #{library['version']}, the version this project locks"
  query = { query: "<symbol or page name>", project: project }
  query[:ref] = library["ref"] unless gem == "_gem_root"
  read = { ref: "<returned document ref>", project: project }
  cli = "posh search '<symbol>'"
  cli += " --ref #{library['ref']}" unless gem == "_gem_root"
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
