import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_restore_mount_is_separate_and_read_only(self):
        args=module.container_args('fresh','owner','restored',module.CANDIDATE,
                                   'backup_restore_replay','original')
        self.assertIn('type=volume,source=restored,target=/app/data',args)
        self.assertIn('type=volume,source=original,target=/fixture-source,readonly',args)
        for phase, source in (('backup_restore_replay',None),('candidate_mint','original'),
                              ('backup_restore_replay','restored')):
            with self.assertRaises(module.HarnessError):
                module.container_args('fresh','owner','restored',module.CANDIDATE,phase,source)
        info={'Config':{'User':'1000:1000'},'HostConfig':{
            'NetworkMode':'none','ReadonlyRootfs':True,'CapDrop':['ALL'],
            'SecurityOpt':['no-new-privileges'],'PidsLimit':64,'Memory':512*1024*1024,
            'Privileged':False,'PortBindings':{},'Binds':None,
            'Tmpfs':{'/tmp':'rw,noexec,nosuid,nodev,size=16m'}},'Mounts':[
            {'Type':'volume','Name':'original','Destination':'/fixture-source','RW':False},
            {'Type':'volume','Name':'restored','Destination':'/app/data','RW':True}]}
        self.assertTrue(module.isolated_container(info,'restored','original'))
        self.assertFalse(module.isolated_container(info,'restored'))
        self.assertFalse(module.isolated_container(info,'restored','restored'))
        for field, value in (('RW',True),('Type','bind'),('Destination','/elsewhere'),('Name','foreign')):
            changed={**info,'Mounts':[{**info['Mounts'][0],field:value},info['Mounts'][1]]}
            self.assertFalse(module.isolated_container(changed,'restored','original'))

    def test_only_matching_missing_resource_is_absent(self):
        for kind in ('volume','container'):
            for text in ('no such '+kind, 'No such '+kind):
                with patch.object(module,'run',return_value=(1,b'[]',text.encode())):
                    self.assertIsNone(module.inspect(kind,'synthetic',optional=True))
            for error in (b'permission denied',b'Cannot connect to the Docker daemon',
                          b'no such image',b'no such '+(b'container' if kind=='volume' else b'volume')):
                with patch.object(module,'run',return_value=(1,b'[]',error)):
                    with self.assertRaises(module.HarnessError):
                        module.inspect(kind,'synthetic',optional=True)


if __name__ == '__main__':
    unittest.main()
