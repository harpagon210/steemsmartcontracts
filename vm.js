const { VM } = require('vm2');


async function executeContract() {
    return new Promise((resolve) => {
        const vm = new VM({
            timeout: 1000,
            sandbox: {
              payload: 'test',
              action: "testAsync",
              log: (msg) => console.log(msg),
              callback: () => resolve(),
              setTimeout: (handle, time) => setTimeout(handle, time)
          
            },
          });
          
          vm.run(`
          let actions = {};
          
          function sleep(ms) {
          return new Promise(resolve => {
              setTimeout(resolve, 4000)
          })
          }
            
          actions.testAsync = function (payload) {
               sleep(4000)
              log(payload)
          }
          
          async function execute() {
              if (action && typeof action === 'string' && typeof actions[action] === 'function') {
                  if (action !== 'createSSC') {
                  actions.createSSC = null;
                  }
                  
                  await actions[action](payload);
                  callback()
              }
          }
          log('sdfsdfs2')
          execute();
          log('sdfsdfs1')
          `);          
    })
}

async function test() {
    await executeContract();
    console.log("test2")
}

console.log("test1")
test()
console.log("test3")