#!/usr/bin/env bash
set -euo pipefail

FS=${FABRIC_SAMPLES:-$HOME/fabric-samples}
TN=$FS/test-network
CC_DIR=$FS/chaincode/spectra
CH=milkchannel
export PATH=$FS/bin:$PATH
export FABRIC_CFG_PATH=$FS/config
export CORE_PEER_TLS_ENABLED=true

ORDERER_CA=$TN/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem
FARMERS_TLS=$TN/organizations/peerOrganizations/farmers.example.com/peers/peer0.farmers.example.com/tls/ca.crt
PRODUCERS_TLS=$TN/organizations/peerOrganizations/producers.example.com/peers/peer0.producers.example.com/tls/ca.crt
FARMERS_ADMIN=$TN/organizations/peerOrganizations/farmers.example.com/users/Admin@farmers.example.com

for f in "$CC_DIR/certificate/certificate.js" "$CC_DIR/certificate/collections-config.json" "$CC_DIR/userauth/userauth.js"; do
  [ -f "$f" ] || { echo "ERROR: missing $f (copy the repository chaincode/ folder to $CC_DIR)"; exit 1; }
done
if command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"; else COMPOSE="docker compose"; fi

echo "Docker server version: $(docker version --format '{{.Server.Version}}')"

cd "$TN"
./network.sh down
./network.sh up

(cd compose && $COMPOSE -f compose-ca.yaml up -d)

./network.sh up createChannel -c $CH -ca

./scripts/deployCC.sh $CH certificate "$CC_DIR/certificate" javascript 1.0 1 NA NA "$CC_DIR/certificate/collections-config.json"

COMMIT_JSON=$(env CORE_PEER_LOCALMSPID=FarmersMSP \
  CORE_PEER_MSPCONFIGPATH=$TN/organizations/peerOrganizations/farmers.example.com/users/User1@farmers.example.com/msp \
  CORE_PEER_ADDRESS=localhost:7051 CORE_PEER_TLS_ROOTCERT_FILE=$FARMERS_TLS \
  peer lifecycle chaincode querycommitted --channelID $CH --name certificate --output json)
echo "$COMMIT_JSON"
echo "$COMMIT_JSON" | jq -e '.collections.config[].Payload.StaticCollectionConfig.name | select(. == "uidPdc")' >/dev/null || {
  echo "ERROR: collection 'uidPdc' not found in the committed definition of 'certificate'"; exit 1; }
echo "OK: collection 'uidPdc' present in the committed definition"

./scripts/deployUserAuth.sh

env CORE_PEER_LOCALMSPID=FarmersMSP CORE_PEER_MSPCONFIGPATH=$FARMERS_ADMIN/msp \
  CORE_PEER_ADDRESS=localhost:7051 CORE_PEER_TLS_ROOTCERT_FILE=$FARMERS_TLS \
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA" \
    -C $CH -n userauth \
    --peerAddresses localhost:7051 --tlsRootCertFiles "$FARMERS_TLS" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$PRODUCERS_TLS" \
    --clientauth --keyfile "$FARMERS_ADMIN/tls/client.key" --certfile "$FARMERS_ADMIN/tls/client.crt" \
    -c '{"function":"InitLedger","Args":[]}' --waitForEvent

PEPPER_B64=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
env CORE_PEER_LOCALMSPID=FarmersMSP CORE_PEER_MSPCONFIGPATH=$FARMERS_ADMIN/msp \
  CORE_PEER_ADDRESS=localhost:7051 CORE_PEER_TLS_ROOTCERT_FILE=$FARMERS_TLS \
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA" \
    -C $CH -n certificate \
    --peerAddresses localhost:7051 --tlsRootCertFiles "$FARMERS_TLS" \
    --peerAddresses localhost:9051 --tlsRootCertFiles "$PRODUCERS_TLS" \
    -c '{"function":"PackagingCertContract:InitPepper","Args":[]}' \
    --transient "{\"pepper\":\"$PEPPER_B64\"}" --waitForEvent
unset PEPPER_B64
echo "UID pepper initialised (random 32 bytes, not stored outside the private data collection)."

echo "Network ready: channel $CH, chaincodes certificate and userauth deployed."
