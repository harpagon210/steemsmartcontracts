#!/usr/bin/env bash

read -p "Enter the mongodb container name : " containerName
read -p "Enter the database name : " database

read -p "$database is going to be dropped in the container $containerName, are you sure? " -n 1 -r
echo    # (optional) move to a new line
if [[ ! $REPLY =~ ^[Yy]$ ]]
then
    [[ "$0" = "$BASH_SOURCE" ]] && exit 1 || return 1 # handle exits from shell or function but don't exit interactive shell
fi

echo "Dropping database $database in the container $containerName"
docker exec $containerName /bin/sh -c "mongo $database --eval \"db.dropDatabase()\""
echo "Done extracting blocks from $containerName"