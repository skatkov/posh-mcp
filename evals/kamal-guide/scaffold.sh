#!/bin/sh
set -e
cat >Gemfile.lock <<'LOCK'
GEM
  remote: https://rubygems.org/
  specs:
    kamal (2.12.0)

PLATFORMS
  ruby

DEPENDENCIES
  kamal
LOCK

sh "$(dirname -- "$0")/../prepare-posh.sh" gem:kamal 2.12.0
