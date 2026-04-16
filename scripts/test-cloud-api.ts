// 测试验证云端数据是否合并正确
const axios = require('axios');

async function testFetch() {
    const baseURL = 'https://wedding.domiyoung.com/api/mp';

    try {
        console.log('--- 正在通过云端 HTTP API 查询校验线上数据 ---');

        // 1. 获取主题列表
        const listRes = await axios.post(`${baseURL}/cases`, {
            pageSize: 50,
            pageNum: 1
        });

        const list = listRes.data.data.list;
        console.log(`[全量数据] 当前线上展示的主题总数：${listRes.data.data.total}`);

        // 检查枫汀南有几个
        const fengtingnanList = list.filter((item: any) => item.title.includes('枫汀南'));
        console.log(`\n[主题排重检查] 线上名叫“枫汀南”的主题数量：${fengtingnanList.length}`);
        if(fengtingnanList.length > 0) {
            console.log(fengtingnanList.map((i: any) => ` ID: ${i.id} | Name: ${i.title}`).join('\n'));
        }

        // 2. 获取具体某一个的详情，查验图片
        if (fengtingnanList.length > 0) {
            const targetId = fengtingnanList[0].id;
            const detailRes = await axios.post(`${baseURL}/case/detail`, { id: targetId });
            
            const imgs = detailRes.data.data.images || [];
            console.log(`\n[图片批次隔离检查] 当前展示给用户看到的“枫汀南”大片数量：${imgs.length}张`);
        }

    } catch (err: any) {
        console.error('线上 API 访问失败:', err.message);
    }
}

testFetch();
