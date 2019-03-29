#!/usr/bin/env bash

read -p "Enter the mongodb container name : " containerName
echo "Extracting blocks from $containerName"
docker exec $containerName /bin/sh -c 'arangoexport --server.database ssc --collection chain --type jsonl'
docker cp $containerName:/data/export/chain.jsonl ./blocks.log
echo "Done extracting blocks from $containerName"