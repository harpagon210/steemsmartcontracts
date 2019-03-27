#!/usr/bin/env bash

read -p "Enter the mongodb container name : " containerName
echo "Extracting blocks from $containerName"
docker exec $containerName /bin/sh -c 'mongoexport -d ssc -c chain -o /data/blocks.log'
docker cp $containerName:/data/blocks.log ./
echo "Done extracting blocks from $containerName"