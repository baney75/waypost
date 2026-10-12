#!/bin/sh
# Bridge keeps its vault key in `pass`, backed by a GPG key that lives only in this container's volume.
set -eu
if [ ! -f "$HOME/.password-store/.gpg-id" ]; then
  gpg --batch --pinentry-mode loopback --passphrase '' --quick-gen-key 'Waypost Bridge <bridge@localhost>' default default never
  pass init 'Waypost Bridge <bridge@localhost>' >/dev/null
fi
# Hand Waypost the public certificate only, so it can pin the TLS connection. The private key stays here.
export_cert() { if [ -f "$HOME/.config/protonmail/bridge-v3/cert.pem" ]; then cp "$HOME/.config/protonmail/bridge-v3/cert.pem" /bridge-public/cert.pem; fi; }
case "${1:-run}" in
  init)
    echo 'Bridge CLI: type "login" and sign in, then "info" to see the IMAP/SMTP username and password, then "exit".'
    protonmail-bridge --cli
    export_cert ;;
  run)
    export_cert
    exec protonmail-bridge --noninteractive ;;
  *) exec "$@" ;;
esac
