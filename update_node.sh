#!/usr/bin/env bash

echo "Saving config.json"
mv config.json config.json.bck
echo "Creating blocks.log file"
cp data/database.db.0 blocks.log
echo "Retrieving latest version of the code"
git pull origin master
echo "Restauring config.json"
mv config.json.bck config.json
echo "Replaying blocks.log"
node app.js -r file
echo "Update done"