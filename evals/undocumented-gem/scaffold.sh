#!/bin/sh
# widget_press is locked but is not a real gem, so POSH has no docset for it: the only
# way to answer is to read this source, exactly as for a private or git-sourced gem.
set -e
cat >Gemfile.lock <<'LOCK'
GEM
  remote: https://rubygems.org/
  specs:
    widget_press (0.1.0)

PLATFORMS
  ruby

DEPENDENCIES
  widget_press
LOCK
mkdir -p vendor/bundle/ruby/4.0.0/gems/widget_press-0.1.0/lib
cat >vendor/bundle/ruby/4.0.0/gems/widget_press-0.1.0/lib/widget_press.rb <<'RUBY'
module WidgetPress
  class Press
    def squeeze(widgets)
      widgets.count { |widget| widget.temperature > 40 }
    end
  end
end
RUBY

# A broken POSH installation must not masquerade as an undocumented-gem fallback.
sh "$(dirname -- "$0")/../prepare-posh.sh" gem:widget_press 0.1.0 missing
