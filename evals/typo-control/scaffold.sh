#!/bin/sh
# A Ruby project, so the ruleset and the hook are both active, with no documentation
# question in the task.
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
cat >README.md <<'MD'
# Widget Reports

A small Rails application that presses widgets and reportts on them.
MD
