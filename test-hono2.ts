import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import fs from 'fs';
const app = new Hono();
app.post('/upload', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    return c.json({
        typeofFile: typeof file,
        isFileString: typeof file === 'string',
        keys: file ? Object.keys(file) : [],
        constructorName: file?.constructor?.name,
        size: (file as any).size,
        hasArrayBuffer: typeof (file as any).arrayBuffer === 'function'
    });
});
import { writeFileSync } from 'fs';
writeFileSync('test.jpg', 'fake image data');
serve({ fetch: app.fetch, port: 8201 }, () => {
    import('child_process').then(cp => {
        cp.exec('curl -s -X POST -F "file=@test.jpg" http://127.0.0.1:8201/upload', (err, stdout) => {
            console.log("RESULT:", stdout);
            process.exit(0);
        });
    });
});
