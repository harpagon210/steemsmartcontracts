# Steem Smart Contracts

 ## 1.  What is it?

Steem Smart Contracts is a sidechain powered by Steem, it allows you to perform actions on a decentralized database via the power of Smart Contracts.

 ## 2.  How does it work?

This is actually pretty easy, you basically need a Steem account and that's it. To interact with the Smart Contracts you simply post a message on the Steem blockchain (formatted in a specific way), the message will then be catched by the sidechain and processed.

 ## 3.  Sidechain specifications
- run on [node.js](https://nodejs.org)
- database layer powered by [LokiJS](https://github.com/techfort/LokiJS)
- Smart Contracts developed in Javascript
- Smart Contracts run in a sandboxed Javascript Virtual Machine called [VM2](https://github.com/patriksimek/vm2)
- a block on the sidechain is produced only if transactions are being parsed in a Steem block

 ## 4.  Roadmap
 This project is actually in an early stage, I will consider it more as a Proof Of Concept for now as important features are still missing:
 - implement the P2P layer
 - implement the Consensus layer (PoS? DPoS? other?)

## 5. Requirements
You need to have NodeJS installed

## 6. Installation

* Clone the repository

* Open a command line

* execute `npm install`

## 7. Run
* node app.js

## 8. Test
* npm test

## 9. Usage

* see wiki: https://github.com/harpagon210/steemsmartcontracts/wiki
