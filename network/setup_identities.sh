#!/usr/bin/env bash
set -uo pipefail

FS=${FABRIC_SAMPLES:-$HOME/fabric-samples}
TN=$FS/test-network
export PATH=$FS/bin:$PATH
export FABRIC_CFG_PATH=$FS/config
export CORE_PEER_TLS_ENABLED=true

CH=milkchannel
CC=userauth
ORDERER_CA=$TN/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem
FARMERS_TLS=$TN/organizations/peerOrganizations/farmers.example.com/peers/peer0.farmers.example.com/tls/ca.crt
PRODUCERS_TLS=$TN/organizations/peerOrganizations/producers.example.com/peers/peer0.producers.example.com/tls/ca.crt
OUT=$(cd "$(dirname "$0")/.." && pwd)/identities.json
TMP=$(mktemp)

IDENTITIES="
bench-farmer|farmers|User1|farmer
bench-producer|producers|User1|producer
bench-consumer|producers|User2|consumer
"

use_identity() {
  local org=$1 user=$2
  if [ "$org" = farmers ]; then
    export CORE_PEER_LOCALMSPID=FarmersMSP CORE_PEER_ADDRESS=localhost:7051 CORE_PEER_TLS_ROOTCERT_FILE=$FARMERS_TLS
  else
    export CORE_PEER_LOCALMSPID=ProducersMSP CORE_PEER_ADDRESS=localhost:9051 CORE_PEER_TLS_ROOTCERT_FILE=$PRODUCERS_TLS
  fi
  export CORE_PEER_MSPCONFIGPATH=$TN/organizations/peerOrganizations/$org.example.com/users/$user@$org.example.com/msp
}

invoke() {
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" -C $CH -n $CC \
    --peerAddresses localhost:7051 --tlsRootCertFiles "$FARMERS_TLS" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$PRODUCERS_TLS" \
    -c "$1" --waitForEvent 2>&1
}

query() {
  peer chaincode query -C $CH -n $CC -c "$1" 2>&1
}

fail() { echo "   ERROR: $1"; rm -f "$TMP"; exit 1; }

while IFS='|' read -r label org user role; do
  [ -z "$label" ] && continue
  echo "== $label  ($user@$org.example.com, role $role)"

  use_identity "$org" "$user"
  [ -d "$CORE_PEER_MSPCONFIGPATH" ] || fail "MSP not found: $CORE_PEER_MSPCONFIGPATH"

  info=$(query '{"function":"UserAuthContract:GetMyIdentity","Args":[]}')
  key=$(echo "$info" | jq -r '.userKey' 2>/dev/null) || fail "GetMyIdentity: $info"
  status=$(echo "$info" | jq -r '.registration.status // "NONE"')
  echo "   userKey: $key"
  echo "   initial status: $status"

  if [ "$status" = NONE ]; then
    out=$(invoke "{\"function\":\"UserAuthContract:RequestUserRegistration\",\"Args\":[\"$label\",\"$role\"]}")
    echo "$out" | grep -q "committed with status (VALID)" || fail "registration: $out"
    echo "   registration requested: PENDING"
    status=PENDING
  fi

  if [ "$status" = PENDING ]; then
    use_identity "$org" Admin
    out=$(invoke "{\"function\":\"UserAuthContract:ApproveUser\",\"Args\":[\"$key\"]}")
    echo "$out" | grep -q "committed with status (VALID)" || fail "approval: $out"
    echo "   approved by the $org Admin: APPROVED"
    use_identity "$org" "$user"
  fi

  check=$(query "{\"function\":\"UserAuthContract:CheckAuthorized\",\"Args\":[\"$role\"]}")
  echo "$check" | jq -e '.authorized == true' >/dev/null 2>&1 || fail "CheckAuthorized: $check"
  echo "   CheckAuthorized($role): OK"

  msp=$CORE_PEER_MSPCONFIGPATH
  cert=$msp/signcerts/$(ls "$msp/signcerts" | head -1)
  sk=$msp/keystore/$(ls "$msp/keystore" | head -1)
  jq -n --arg label "$label" --arg mspId "$CORE_PEER_LOCALMSPID" --arg role "$role" \
        --arg user "$user@$org.example.com" --arg userKey "$key" \
        --arg peer "$CORE_PEER_ADDRESS" --arg peerTls "$CORE_PEER_TLS_ROOTCERT_FILE" \
        --arg cert "$cert" --arg key "$sk" \
        '{label:$label, user:$user, mspId:$mspId, role:$role, userKey:$userKey,
          peerEndpoint:$peer, peerTlsCert:$peerTls, certPath:$cert, keyPath:$key}' >> "$TMP"
done <<< "$IDENTITIES"

jq -s '.' "$TMP" > "$OUT"
rm -f "$TMP"
echo
echo "Done. Identities written to $OUT (contains paths to private keys: do not publish)."
