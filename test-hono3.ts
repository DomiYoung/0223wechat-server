import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import fs from 'fs';
const app = new Hono();
app.post('/upload', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'] as any;
    
    // First try: stream DIRECTLY
    if (typeof file.stream === 'function') {
        const chunks = [];
        for await (const chunk of file.stream()) {
            chunks.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);
        return c.json({ sizeStream: buffer.length });
    }
    
    return c.json({ error: 'no file' });
});

fs.writeFileSync('test.jpg', 'fake image data 1234');
serve({ fetch: app.fetch, port: 8202 }, () => {
    import('child_process').then(cp => {
        cp.exec('curl -s -X POST -F "file=@test.jpg" http://127.0.0.1:8202/upload', (err, stdout) => {
            console.log("RESULT:", stdout);
            process.exit(0);
        });
    });
});
