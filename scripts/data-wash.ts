import pool from '../src/db.js';

async function wash() {
  console.log('--- Starting Data Wash ---');
  
  // 1. Get business category ID
  const [catRows] = await pool.query('SELECT id FROM package_category WHERE slug = ? LIMIT 1', ['business']) as any;
  const businessCategoryId = catRows.length > 0 ? catRows[0].id : null;
  
  if (!businessCategoryId) {
    console.error('Business category not found. Please ensure package_category has a slug "business".');
    process.exit(1);
  }

  // 2. Get all active packages
  const [packages] = await pool.query('SELECT id, title, category_id, price FROM package WHERE is_active = 1') as any;
  console.log(`Found ${packages.length} active packages to process.`);

  for (const pkg of packages) {
    let updateNeeded = false;
    let newCategoryId = pkg.category_id;
    let newPrice = pkg.price;

    // Rule: No "筵" = Business
    if (!pkg.title.includes('筵') && pkg.category_id !== businessCategoryId) {
      console.log(`[Move] "${pkg.title}" -> Business Category`);
      newCategoryId = businessCategoryId;
      updateNeeded = true;
    }

    // Extract price if null
    if (pkg.price === null || pkg.price === 0) {
      const priceMatch = pkg.title.match(/(\d+)/);
      if (priceMatch) {
        newPrice = parseInt(priceMatch[1], 10);
        console.log(`[Price] "${pkg.title}" -> Extracted Price: ${newPrice}`);
        updateNeeded = true;
      }
    }

    if (updateNeeded) {
      await pool.query(
        'UPDATE package SET category_id = ?, price = ? WHERE id = ?',
        [newCategoryId, newPrice, pkg.id]
      );
    }
  }

  console.log('--- Data Wash Completed ---');
  process.exit(0);
}

wash().catch(err => {
  console.error('Data wash failed:', err);
  process.exit(1);
});
