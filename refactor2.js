const fs = require('fs');
let content = fs.readFileSync('src/index.ts', 'utf8');

content = content.replace(/c\.json\(\{\s*error:\s*(.*?)\s*\}\s*,\s*(\d+)\)/g, "c.json({ code: $2, message: $1 }, $2)");

fs.writeFileSync('src/index.ts', content);
