import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

function pdfFixture(count:number,width:number,height:number) {
  const font=count+3;
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({length:count},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${count} >>`,
    ...Array.from({length:count},(_,i)=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${font+i+1} 0 R >>`),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...Array.from({length:count},(_,i)=>{const text=`BT /F1 24 Tf 50 ${height-70} Td (Adaptive page ${i+1}) Tj ET`;return `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;}),
  ];
  let result='%PDF-1.4\n';const offsets=[0];
  objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(result);result+=`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

test('PDF automatically fits single/double pages to viewport, orientation and zoom without losing the reading page',async({page},testInfo)=>{
  const status=await(await page.request.get('/api/auth/status')).json();expect((await page.request.post(status.needsSetup?'/api/auth/setup':'/api/auth/login',{data:{username:'e2e-admin',password:'test-password'}})).ok()).toBeTruthy();
  const root=join(process.cwd(),'.test-data/e2e/pdf-layout');mkdirSync(root,{recursive:true});
  writeFileSync(join(root,'portrait.pdf'),pdfFixture(5,595,842));writeFileSync(join(root,'landscape.pdf'),pdfFixture(2,842,595));writeFileSync(join(root,'single.pdf'),pdfFixture(1,595,842));
  const {project}=await(await page.request.post('/api/projects',{data:{name:'Adaptive PDF',path:root}})).json();
  await page.request.put('/api/settings',{data:{settings:{statusline_prompted:'true',app_theme:'light'}}});await page.request.put('/api/user-state/app',{data:{value:{projectTabs:[{projectId:project.id,projectName:project.name}],activeTab:`project-${project.id}`}}});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1800,height:1000});await page.goto('/');const toggle=page.getByRole('button',{name:'File Explorer',exact:true});await toggle.click();
  const tree=page.getByRole('complementary',{name:'项目文件树'});await tree.getByRole('button',{name:'portrait.pdf',exact:true}).click();
  const preview=page.getByLabel('PDF 预览',{exact:true}),pages=preview.getByLabel('PDF 页面',{exact:true}),scroll=preview.locator('.overflow-auto');
  const sheet=(number:number)=>preview.getByLabel(`PDF 第 ${number} 页容器`,{exact:true});
  await expect(pages).toHaveAttribute('data-columns','2');await expect(preview.getByText('自动双页',{exact:true})).toBeVisible();
  await expect(preview.getByLabel('PDF 第 1 页',{exact:true})).toHaveAttribute('data-rendered','true');await expect(preview.getByLabel('PDF 第 2 页',{exact:true})).toHaveAttribute('data-rendered','true');
  const first=await sheet(1).boundingBox(),second=await sheet(2).boundingBox(),third=await sheet(3).boundingBox();expect(Math.abs(first!.y-second!.y)).toBeLessThan(2);expect(second!.x).toBeGreaterThan(first!.x+first!.width);expect(third!.y).toBeGreaterThan(first!.y+first!.height);
  await page.screenshot({path:testInfo.outputPath('pdf-double-pages.png')});
  await sheet(3).evaluate(node=>{const root=node.closest('[aria-label="PDF 预览"]')!.querySelector('.overflow-auto')!;root.scrollTop+=node.getBoundingClientRect().top-root.getBoundingClientRect().top-16;});
  await expect(preview.getByLabel('PDF 第 3 页',{exact:true})).toHaveAttribute('data-rendered','true');
  await page.setViewportSize({width:1200,height:1000});await expect(pages).toHaveAttribute('data-columns','1');
  await expect.poll(async()=>{const p=await sheet(3).boundingBox(),area=await scroll.boundingBox();return Math.abs(p!.y-area!.y-16);}).toBeLessThan(5);
  // Collapsing just the sidebar also changes the available document width.
  await toggle.click();await expect(pages).toHaveAttribute('data-columns','2');await toggle.click();await expect(pages).toHaveAttribute('data-columns','1');
  await page.setViewportSize({width:1800,height:1000});await expect(pages).toHaveAttribute('data-columns','2');
  await preview.getByRole('button',{name:'放大 PDF'}).click();await preview.getByRole('button',{name:'放大 PDF'}).click();await expect(pages).toHaveAttribute('data-columns','1');await expect(preview.getByText('150%',{exact:true})).toBeVisible();
  await preview.getByRole('button',{name:'缩小 PDF'}).click();await preview.getByRole('button',{name:'缩小 PDF'}).click();await expect(pages).toHaveAttribute('data-columns','2');
  await tree.getByRole('button',{name:'landscape.pdf',exact:true}).click();await expect(preview.getByText('2 页 · 连续滚动',{exact:true})).toBeVisible();await expect(pages).toHaveAttribute('data-columns','1');
  await tree.getByRole('button',{name:'single.pdf',exact:true}).click();await expect(preview.getByText('1 页 · 连续滚动',{exact:true})).toBeVisible();await expect(pages).toHaveAttribute('data-columns','1');
  await page.setViewportSize({width:390,height:844});await tree.getByRole('button',{name:'portrait.pdf',exact:true}).click();await expect(preview.getByText('5 页 · 连续滚动',{exact:true})).toBeVisible();await expect(pages).toHaveAttribute('data-columns','1');
  await expect(preview.getByLabel('PDF 第 1 页',{exact:true})).toHaveAttribute('data-rendered','true');
  expect(await scroll.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(preview.getByLabel('PDF 第 5 页',{exact:true})).toHaveAttribute('data-rendered','false');expect(errors).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('pdf-mobile-single-page.png')});
});
