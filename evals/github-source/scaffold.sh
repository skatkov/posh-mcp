#!/bin/sh
set -e
cat >Gemfile.lock <<'LOCK'
GEM
  remote: https://rubygems.org/
  specs:
    nokogiri (1.19.7)

PLATFORMS
  ruby

DEPENDENCIES
  nokogiri
LOCK

sh "$(dirname -- "$0")/../prepare-posh.sh" gem:nokogiri 1.19.7 github-source
