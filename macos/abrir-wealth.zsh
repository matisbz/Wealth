#!/bin/zsh
set -eu

project_dir=${0:A:h:h}
url='http://127.0.0.1:4317'
job='local.wealth.server'
service="gui/$(id -u)/$job"

wealth_ready() {
  local callback
  callback=$(/usr/bin/curl --noproxy '*' --silent --fail --max-time 1 "$url/api/dashboard" |
    /usr/bin/plutil -extract callback raw -o - - 2>/dev/null) || return 1
  [[ "$callback" == "https://127.0.0.1:4318/callback" ]]
}

if ! wealth_ready; then
  if /usr/sbin/lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
    print -u2 'Otra aplicación utiliza el puerto 4317. Ciérrala y vuelve a abrir Wealth.'
    exit 1
  fi

  if /bin/launchctl print "$service" >/dev/null 2>&1; then
    /bin/launchctl kickstart "$service"
  else
    node_bin=''
    for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/v*/bin/node(NOn); do
      if [[ -x "$candidate" ]] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
        node_bin=$candidate
        break
      fi
    done
    if [[ -z "$node_bin" ]]; then
      print -u2 'Wealth necesita Node.js 22 o posterior para arrancar.'
      exit 1
    fi
    /bin/launchctl submit -l "$job" -- "$node_bin" "$project_dir/server.js"
  fi

  for attempt in {1..50}; do
    wealth_ready && break
    /bin/sleep 0.2
  done
  if ! wealth_ready; then
    print -u2 'El servidor local de Wealth no ha respondido. Vuelve a abrir Wealth para reintentarlo.'
    exit 1
  fi
fi

if [[ ${1:-} == --semanal ]]; then
  /usr/bin/open -g "$url/?actualizacion=$2"
else
  /usr/bin/open "$url/"
fi
