import { initDB } from '../src/db.js';
initDB().then(() => { console.log('DB init done'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
