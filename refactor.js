const fs = require('fs');
let content = fs.readFileSync('src/index.ts', 'utf8');

// Replace { error: ... } with { code: 1, message: ... }
content = content.replace(/c\.json\(\{\s*error:\s*(.*?)\s*\}\s*,\s*(\d+)\)/g, "c.json({ code: $2, message: $1 }, $2)");

// For { code: 0, data: ... }, we keep it, but maybe add message: 'success'
content = content.replace(/c\.json\(\{\s*code:\s*0\s*\}\)/g, "c.json({ code: 0, message: 'success' })");
content = content.replace(/c\.json\(\{\s*code:\s*0,\s*data:\s*(.*?)\s*\}\)/g, "c.json({ code: 0, message: 'success', data: $1 })");

fs.writeFileSync('src/index.ts', content);
