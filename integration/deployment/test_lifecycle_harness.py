import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('lifecycle_smoke', Path(__file__).with_name('lifecycle_smoke.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Guards(unittest.TestCase):
    def test_only_full_pinned_image_ids(self):
        self.assertEqual(module.require_image_id(module.BASELINE), module.BASELINE)
        for value in ('local/test-claudemock:0ca7575','sha256:123','SHA256:'+'a'*64,None):
            with self.assertRaises(module.HarnessError):
                module.require_image_id(value)

    def test_volume_requires_owner_and_local_empty_options(self):
        info = {'Name':'fresh','Driver':'local','Options':None,'Labels':{
            module.OWNER_LABEL:'owner',module.KIND_LABEL:module.KIND}}
        self.assertTrue(module.owned_volume(info,'fresh','owner'))
        self.assertFalse(module.owned_volume(info,'fresh','other'))
        self.assertFalse(module.owned_volume(info,'wrong','owner'))
        for field, value in (('Driver','nfs'),('Options',{'device':'/existing'}),('Labels',{})):
            self.assertFalse(module.owned_volume({**info,field:value},'fresh','owner'))

    def test_container_requires_exact_image_and_owner(self):
        info={'Name':'/fresh','Image':module.BASELINE,'Config':{'Image':module.BASELINE,'Labels':{
            module.OWNER_LABEL:'owner',module.KIND_LABEL:module.KIND}}}
        self.assertTrue(module.owned_container(info,'fresh','owner',module.BASELINE))
        self.assertFalse(module.owned_container(info,'fresh','owner',module.CANDIDATE))
        self.assertFalse(module.owned_container(info,'fresh','other',module.BASELINE))
        self.assertFalse(module.owned_container({**info,'Name':'/other'},'fresh','owner',module.BASELINE))
        changed={**info,'Config':{**info['Config'],'Image':'a-tag'}}
        self.assertFalse(module.owned_container(changed,'fresh','owner',module.BASELINE))

    def test_command_has_no_pull_build_host_network_or_bind_mount(self):
        args=module.container_args('fresh','owner','volume',module.CANDIDATE,'candidate_mint')
        for token in ('--pull=never','--network=none','--read-only','--user=1000:1000',
                      '--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=512m'):
            self.assertIn(token,args)
        self.assertIn('type=volume,source=volume,target=/app/data',args)
        self.assertNotIn('--publish',args)
        self.assertNotIn('--privileged',args)
        self.assertEqual(args[-4:],[module.CANDIDATE,'--input-type=module','-','candidate_mint'])

    def test_inspected_isolation_is_required(self):
        info={'Config':{'User':'1000:1000'},'HostConfig':{
            'NetworkMode':'none','ReadonlyRootfs':True,'CapDrop':['ALL'],
            'SecurityOpt':['no-new-privileges'],'PidsLimit':64,'Memory':512*1024*1024,
            'Privileged':False,'PortBindings':{},'Binds':None,
            'Tmpfs':{'/tmp':'rw,noexec,nosuid,nodev,size=16m'}},'Mounts':[
            {'Type':'volume','Name':'fresh','Destination':'/app/data','RW':True}]}
        self.assertTrue(module.isolated_container(info,'fresh'))
        for field,value in (('NetworkMode','host'),('ReadonlyRootfs',False),('CapDrop',[]),
                            ('SecurityOpt',[]),('Privileged',True),('PortBindings',{'18081':[]})):
            changed={**info,'HostConfig':{**info['HostConfig'],field:value}}
            self.assertFalse(module.isolated_container(changed,'fresh'))
        self.assertFalse(module.isolated_container(info,'other'))


if __name__ == '__main__':
    unittest.main()
