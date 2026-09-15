import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root=process.cwd();
mkdirSync(resolve(root,'work/runtime'),{recursive:true});
for(const [region,port,webPort] of [['CN',55431,3100],['HK',55432,3101]]) {
  const envPath=resolve(root,`work/local-${region.toLowerCase()}.env`);
  const dbEnvPath=resolve(root,`work/runtime/postgres-${region.toLowerCase()}.env`);
  const name=`nova-psycho-helper-${region.toLowerCase()}-db`;
  const dbName=`nova_${region.toLowerCase()}`;
  if(!existsSync(envPath)) {
    const password=randomBytes(24).toString('hex');
    writeFileSync(dbEnvPath,`POSTGRES_USER=nova\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${dbName}\n`,{mode:0o600});
    writeFileSync(envPath,[
      'NOVA_MODE=demo',`NOVA_REGION=${region}`,`DATABASE_URL=postgresql://nova:${password}@127.0.0.1:${port}/${dbName}`,
      `NOVA_PUBLIC_URL=http://127.0.0.1:${webPort}`,`NOVA_DEMO_SIBLING_URL=http://127.0.0.1:${region==='CN'?3101:3100}`,
      `NOVA_REPORT_DIR="${resolve(root,`work/private-reports/${region}`)}"`,
      `NOVA_REPORT_KEY=${randomBytes(32).toString('hex')}`,
      'NOVA_AI_ENABLED=false'
    ].join('\n')+'\n',{mode:0o600});
  }
  let exists=false;
  try { execFileSync('docker',['container','inspect',name],{stdio:'ignore'});exists=true; } catch {}
  if(exists) execFileSync('docker',['start',name],{stdio:'ignore'});
  else execFileSync('docker',['run','-d','--name',name,'--label','app=nova-psycho-helper','--env-file',dbEnvPath,'-p',`127.0.0.1:${port}:5432`,'-v',`nova_psycho_${region.toLowerCase()}_data:/var/lib/postgresql/data`,'--health-cmd',`pg_isready -U nova -d ${dbName}`,'--health-interval','2s','--health-retries','15','postgres:16-alpine'],{stdio:'ignore'});
  console.log(`${region}: private local environment ready; database ${port}, web ${webPort}.`);
}
