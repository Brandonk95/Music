#!/bin/sh
# Gives every build its own script/style URLs (?v=<version>), so no cache in
# between -- the browser, a service worker or a CDN such as Cloudflare -- can
# pair a new page with old scripts after an update.
set -e
V="$1"
DIR="${2:-/pb/pb_public}"
[ -n "$V" ] || V=$(date +%s)
sed -i \
  -e "s#href=\"css/app.css\"#href=\"css/app.css?v=$V\"#" \
  -e "s#src=\"js/app.js\"#src=\"js/app.js?v=$V\"#" \
  "$DIR/index.html"
sed -i \
  -e "s#\(from '\./[A-Za-z0-9_-]*\.js\)'#\1?v=$V'#g" \
  -e "s#addModule('js/capture-worklet.js')#addModule('js/capture-worklet.js?v=$V')#" \
  "$DIR"/js/*.js
sed -i -e "s#const CACHE = '\([^']*\)'#const CACHE = '\1-$V'#" "$DIR/sw.js"
echo "Stamped app files with version $V"
