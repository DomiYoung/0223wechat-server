const https = require('https');
const API = 'https://wedding.domiyoung.com';

function req(url, method, data, token) {
  return new Promise(resolve => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers: { 'Content-Type': 'application/json' } };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    const r = https.request(opts, res => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>{ try{resolve({s:res.statusCode,d:JSON.parse(b)})}catch(e){resolve({s:res.statusCode,d:b})} }); });
    if (data) r.write(JSON.stringify(data));
    r.end();
  });
}

(async () => {
  const lr = await req(`${API}/api/admin/login`, 'POST', { username: 'admin', password: 'wedding2024' });
  const token = lr.d.data.token;

  const cr = await req(`${API}/api/admin/package-categories`, 'GET', null, token);
  const cats = cr.d.data;
  const catMap = {};
  for (const c of cats) catMap[c.slug] = c.id;
  console.log('Categories:', cats.map(c => `[${c.id}] ${c.slug} "${c.name}"`));

  const pr = await req(`${API}/api/admin/packages?pageSize=500`, 'GET', null, token);
  const pkgs = pr.d.data;
  console.log(`\nTotal items: ${pkgs.length}\n`);

  // 先列出每项当前归属
  for (const p of pkgs) {
    const catSlug = cats.find(c => c.id === p.category_id)?.slug || '?';
    console.log(`  [${catSlug}] ${p.title}`);
  }

  // 精确分类规则
  let updated = 0;
  for (const p of pkgs) {
    const t = p.title || '';
    let target = null;

    // 宝宝宴/生日 → birthday
    if (t.includes('宝宝') || t.includes('生日') || t.includes('百天') || t.includes('满月')) {
      target = 'birthday';
    }
    // 商务/年会/会议 → business
    else if (t.includes('商务') || t.includes('年会') || t.includes('会议')) {
      target = 'business';
    }
    // 婚宴菜单类：含"菜单"、或含"筵"（雅尊筵/至尊筵/悦尊筵/御尊筵/尚尊筵/鼎尊筵）、或含"婚宴"
    else if (t.includes('菜单') || t.includes('筵') || t.includes('婚宴')) {
      target = 'wedding_menu';
    }
    // 其余 → 婚庆套餐
    else {
      target = 'wedding_pkg';
    }

    const targetId = catMap[target];
    if (p.category_id !== targetId) {
      console.log(`\n>>> MOVE: "${t}" -> ${target}`);
      const payload = { ...p, category_id: targetId, price: p.price ?? null, is_active: p.is_active ? 1 : 0 };
      const ur = await req(`${API}/api/admin/packages/${p.id}`, 'PUT', payload, token);
      if (ur.s === 200) { updated++; console.log('    OK'); } else console.log('    FAIL', ur.d);
    }
  }
  console.log(`\nDone. Moved ${updated} items.`);
})();
