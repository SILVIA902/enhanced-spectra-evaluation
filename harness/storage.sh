#!/usr/bin/env bash
echo "node,kb,path"
for c in peer0.farmers.example.com peer0.producers.example.com; do
  docker exec "$c" sh -c 'cd /var/hyperledger/production/ledgersData && du -sk chains stateLeveldb pvtdataStore historyLeveldb' \
    | awk -v n="$c" '{print n "," $1 "," $2}'
done
docker exec orderer.example.com sh -c 'cd /var/hyperledger/production/orderer && du -sk chains' \
  | awk '{print "orderer.example.com," $1 "," $2}'
