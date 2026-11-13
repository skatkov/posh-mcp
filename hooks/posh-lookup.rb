# Shared lookup policy for every harness. No third-party gems required.
require "json"
require "open3"
require "fileutils"
require "shellwords"
require "uri"
require "rubygems"
require "digest"

def ruby_project(dir)
  while dir != "/" && dir != Dir.home
    names = Dir.children(dir)
    return dir if names.any? { |name| %w[Gemfile Gemfile.lock gems.rb].include?(name) || name.end_with?(".gemspec") }
    return if names.include?(".git")
    dir = File.dirname(dir)
  end
end

def lookup_for_path(path)
  path = File.expand_path(path)
  roots = Gem.path.select { |home| path == home || path == "#{home}/gems" || path.start_with?("#{home}/gems/") }
  path.scan(%r{/(?:vendor/bundle|ruby/gems|gems/\d+\.\d+(?:\.\d+)?|\.gem/(?:ruby|jruby)/[^/]+)(?=/|\z)}) do
    roots << path[0...Regexp.last_match.end(0)]
  end
  root = roots.max_by(&:length)
  return unless root

  relative = path.delete_prefix(root)
  match = relative.match(%r{\A(?:/(?:ruby|jruby|truffleruby)/[^/]+|/\d+\.\d+(?:\.\d+)?|/\*\*)?/gems/([a-zA-Z0-9_.-]+)-[0-9][0-9a-zA-Z.]*})
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

def lookup_for_command(command, cwd)
  # shortcut: recognize literal-leading commands, not arbitrary shell syntax;
  # compound-command tails are left to normal permissions.
  words = Shellwords.split(command)
  words = words.drop(2) if words[0, 2] == %w[bundle exec]
  tool, *arguments = words
  arguments = arguments.take_while { |word| !%w[&& || | ;].include?(word) }
  case tool
  when "gem", "bundle"
    action, name = arguments
    if ((tool == "gem" && %w[contents which unpack].include?(action)) ||
        (tool == "bundle" && %w[show open].include?(action))) && name&.match?(/\A[a-zA-Z0-9_][a-zA-Z0-9_.-]*\z/)
      return "gem:#{name}"
    end
  when "curl", "wget"
    arguments.each do |word|
      lookup = lookup_for_url(word)
      return lookup if lookup
    end
  when "cat", "sed", "grep", "rg", "find", "ls", "head", "tail", "awk", "cd"
    arguments.each do |word|
      lookup = lookup_for_path(File.expand_path(word, cwd))
      return lookup if lookup
    end
  end
end

def posh_redirect(input)
  return unless input.is_a?(Hash) && input["tool_input"].is_a?(Hash)

  cwd = input["cwd"]
  session = input["session_id"]
  return unless cwd.is_a?(String) && File.directory?(cwd)
  return unless session.is_a?(String) && session.match?(/\A[a-zA-Z0-9_-]+\z/)
  cwd = File.realpath(cwd)
  mode_file = File.join(ENV.fetch("XDG_CONFIG_HOME", File.join(Dir.home, ".config")), "posh/agent-mode")
  return if File.file?(mode_file) && File.read(mode_file).strip == "off"
  project = ruby_project(cwd)
  return unless project

  args = input["tool_input"]
  lookup = case input["tool_name"]
  when "Read"
    lookup_for_path(File.expand_path(args.fetch("file_path"), cwd))
  when "Grep"
    lookup_for_path(File.expand_path(args.fetch("path", cwd), cwd))
  when "Glob"
    lookup_for_path(File.expand_path(File.join(args.fetch("path", cwd), args.fetch("pattern")), cwd))
  when "WebFetch"
    lookup_for_url(args.fetch("url"))
  when "Bash"
    lookup_for_command(args.fetch("command"), cwd)
  end
  return unless lookup
  ref = lookup == :gem_tree ? nil : lookup

  state = ENV["PLUGIN_DATA"] || ENV["CLAUDE_PLUGIN_DATA"] || File.join(ENV.fetch("XDG_CACHE_HOME", File.join(Dir.home, ".cache")), "posh")
  marker = File.join(state, "nudged", "#{session}.#{Digest::SHA256.hexdigest(project)}.#{ref || 'gem-tree'}")
  return if File.exist?(marker)

  command = ["posh", "docsets", "--json", "--project", project]
  command += ["--filter", ref] if ref
  stdout, _stderr, status = Open3.capture3(*command, chdir: cwd)
  return unless status.success?

  docs = JSON.parse(stdout)
  return unless docs.is_a?(Hash) && docs["ok"] == true && docs["data"].is_a?(Array)
  return unless File.realpath(docs.fetch("project_path")) == project

  library = docs["data"].find do |row|
    row.is_a?(Hash) && row["ref"].is_a?(String) && row["ref"].start_with?("gem:") &&
      (!ref || row["ref"] == ref) &&
      row["kinds"].is_a?(Array) && !row["kinds"].empty?
  end
  return unless library

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
  <<~TEXT
    POSH has local documentation for #{subject}.

    Use POSH's search tool with #{JSON.generate(query)}, or `#{cli}`, then read the returned document ref using #{JSON.generate(read)}. For CLI reads, keep the same --project argument. Search for README or CHANGELOG for those pages.

    This redirect fires once per gem per session. If POSH cannot answer, retry the original call; it will go through. Source inspection remains available for implementation details and debugging.
  TEXT
rescue StandardError
  # Invalid input, unavailable POSH, or unwritable state must never block real work.
  nil
end

if $PROGRAM_NAME == __FILE__
  begin
    reason = posh_redirect(JSON.parse($stdin.read))
    puts JSON.generate(reason: reason) if reason
  rescue StandardError
    # Malformed transport input also fails open.
  end
end
