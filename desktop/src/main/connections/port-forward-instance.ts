import { broker } from './broker-instance'
import { PortForwardManager } from './port-forward'

/** One Port Forward manager for the whole process, over the one broker. */
export const portForwards = new PortForwardManager(broker)
