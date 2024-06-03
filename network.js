import Hyperswarm from 'hyperswarm'   // Module for P2P networking and connecting peers
const { teardown } = Pear             // Cleanup function

export const swarm = new Hyperswarm()

// Unannounce the public key before exiting the process
// (This is not a requirement, but it helps avoid DHT pollution)
teardown(() => swarm.destroy())
