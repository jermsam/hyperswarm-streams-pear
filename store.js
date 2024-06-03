
import RAM from "random-access-memory";
import Corestore from "corestore";
import b4a from 'b4a';
const storage = RAM.reusable();

export const store = new Corestore(storage);
// const coreKey = 'video-stream'
// const topic = await crypto.subtle.digest('SHA-256', b4a.from(coreKey, 'hex')).then(b4a.from);

// export const core = store.get(topic)


