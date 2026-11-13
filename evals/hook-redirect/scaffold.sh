#!/bin/sh
# Synthetic source with a misleading comment, for an upstream-version docs question.
set -e
cat >Gemfile.lock <<'LOCK'
GEM
  remote: https://rubygems.org/
  specs:
    activerecord (8.1.4.1)

PLATFORMS
  ruby

DEPENDENCIES
  activerecord
LOCK

dir=vendor/bundle/ruby/4.0.0/gems/activerecord-8.1.4.1/lib/active_record
mkdir -p "$dir"
cat >"$dir/relation.rb" <<'RUBY'
module ActiveRecord
  class Relation
    # Updates all records in the current relation. Each record is instantiated, so
    # validations and callbacks run for every row, and updated_at is refreshed.
    def update_all(updates)
      connection.update(arel.compile_update(updates))
    end
  end
end
RUBY

sh "$(dirname -- "$0")/../prepare-posh.sh" gem:activerecord 8.1.4.1
