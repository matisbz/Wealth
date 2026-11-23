#!/bin/zsh
set -eu
cd "${0:A:h:h}"
cert="$PWD/.wealth/tls/cert.crt"
if [[ ! -f "$cert" ]]; then
  print -u2 'Abre Wealth desde el Dock para generar primero su certificado local.'
  exit 1
fi
/usr/bin/security add-trusted-cert -r trustRoot -p ssl -s 127.0.0.1 -k "$HOME/Library/Keychains/login.keychain-db" "$cert"
/usr/bin/security verify-cert -L -c "$cert" -p ssl -n 127.0.0.1
print 'El certificado HTTPS de Wealth está listo.'
