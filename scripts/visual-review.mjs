import { chromium } from "../frontend/node_modules/playwright/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root=process.cwd();
const out=resolve(root,"test-results");
await mkdir(out,{recursive:true});
const browser=await chromium.launch({
 executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
 headless:true,
 args:["--disable-gpu","--no-first-run","--no-default-browser-check"]
});
try {
 const page=await browser.newPage({viewport:{width:1440,height:940},deviceScaleFactor:1});
 await page.goto("http://127.0.0.1:4173",{waitUntil:"networkidle"});
 await page.locator('input[type="file"]').setInputFiles(resolve(root,"test-data/gaussian-integral.png"));
 await page.waitForFunction(()=>document.querySelector(".formula-image")?.naturalWidth>0);
 await page.screenshot({path:resolve(out,"desktop-ui-review.png"),fullPage:true});
 const data=await page.evaluate(()=>({
  title:document.title,
  toolbar:!!document.querySelector(".desktop-toolbar"),
  nativeWindowDecorations:getComputedStyle(document.querySelector(".desktop-toolbar")).display!=="none",
  appGrid:getComputedStyle(document.querySelector(".app-shell")).gridTemplateColumns,
  headerHeight:getComputedStyle(document.querySelector(".desktop-toolbar")).height,
  sections:[...document.querySelectorAll(".center-column,.right-column")].map(x=>x.className),
  imageLoaded:document.querySelector(".formula-image")?.naturalWidth>0,
  visibleText:document.body.innerText.includes("输出格式")&&document.body.innerText.includes("识别结果")
 }));
 if(!data.toolbar||!data.imageLoaded||!data.visibleText) throw new Error(JSON.stringify(data));
 await writeFile(resolve(out,"ui-layout.json"),JSON.stringify(data,null,2));
 console.log(JSON.stringify(data));
} finally { await browser.close(); }
