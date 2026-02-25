import { Hono } from 'hono';
import { serve } from '@hono/node-server';
const app = new Hono();
app.post('/upload', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (file && typeof file !== 'string') {
        const ab = await file.arrayBuffer();
        return c.json({ size: ab.byteLength });
    }
    return c.json({ error: 'no file' });
});
serve({ fetch: app.fetch, port: 8200 });
