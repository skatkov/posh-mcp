#!/bin/sh
# A project that locks a gem POSH has a docset for, and app code that uses it.
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
mkdir -p app/models
cat >app/models/report.rb <<'RUBY'
class Report < ApplicationRecord
  def self.mark_all_stale
    where(stale: false).update_all(stale: true)
  end
end
RUBY

sh "$(dirname -- "$0")/../prepare-posh.sh" gem:activerecord 8.1.4.1
