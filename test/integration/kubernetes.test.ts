import { CoreV1Api, KubeConfig, AppsV1Api } from '@kubernetes/client-node';
import { exec } from 'child-process-promise';
import setup = require('../setup');
import * as tap from 'tap';
import { WorkloadKind } from '../../src/supervisor/types';
import { WorkloadMetadataValidator, WorkloadLocatorValidator } from '../helpers/types';
import {
  validateUpstreamStoredData,
  validateUpstreamStoredMetadata,
  getUpstreamResponseBody,
  validateUpstreamStoredDepGraphs,
} from '../helpers/kubernetes-upstream';
import {
  validateSecureConfiguration,
  validateVolumeMounts,
  validateEnvironmentVariables,
} from '../helpers/deployment';
import * as kubectl from '../helpers/kubectl';

let integrationId: string;
let namespace: string;

async function teardown(): Promise<void> {
  console.log('Begin removing the snyk-monitor...');
  await setup.removeMonitor();
  console.log('Removed the snyk-monitor!');

  console.log('Begin removing "kind" network...');
  await setup.removeUnusedKindNetwork();
  console.log('Removed "kind" network');
}

tap.tearDown(teardown);

tap.test('teardown any existing environment', async (t) => {
  await teardown();
  t.pass('starting from a clean environment');
});

// Make sure this runs first -- deploying the monitor for the next tests
tap.test('deploy snyk-monitor', async (t) => {
  namespace  = setup.snykMonitorNamespace();

  integrationId = await setup.deployMonitor();
  t.pass('successfully deployed the snyk-monitor');
});

// Next we apply some sample workloads
tap.test('deploy sample workloads', async (t) => {
  const servicesNamespace = 'services';
  const someImageWithSha = 'alpine@sha256:7746df395af22f04212cd25a92c1d6dbc5a06a0ca9579a229ef43008d4d1302a';
  await Promise.all([
    kubectl.applyK8sYaml('./test/fixtures/alpine-pod.yaml'),
    kubectl.applyK8sYaml('./test/fixtures/nginx-replicationcontroller.yaml'),
    kubectl.applyK8sYaml('./test/fixtures/redis-deployment.yaml'),
    kubectl.applyK8sYaml('./test/fixtures/centos-deployment.yaml'),
    kubectl.applyK8sYaml('./test/fixtures/scratch-deployment.yaml'),
    kubectl.createPodFromImage('alpine-from-sha', someImageWithSha, servicesNamespace),
  ]);
  t.pass('successfully deployed sample workloads');
});

tap.test('snyk-monitor container started', async (t) => {
  t.plan(4);

  console.log('Getting KinD config...');
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  const k8sApi = kubeConfig.makeApiClient(CoreV1Api);
  console.log('Loaded KinD config!');

  console.log('Querying the snyk-monitor...');
  const response = await k8sApi.listNamespacedPod(namespace);
  t.ok(response.body.items.length > 0, 'PodList is not empty');

  const monitorPod = response.body.items.find((pod) => pod.metadata !== undefined &&
    pod.metadata.name !== undefined && pod.metadata.name.includes('snyk-monitor'));
  t.ok(monitorPod !== undefined, 'Snyk monitor container exists');
  t.ok(monitorPod!.status !== undefined, 'Snyk monitor status object exists');
  t.notEqual(monitorPod!.status!.phase, 'Failed', 'Snyk monitor container didn\'t fail');
  console.log('Done -- snyk-monitor exists!');
});

tap.test('create local container registry and push an image', async (t) => {
  if (process.env['TEST_PLATFORM'] !== 'kind') {
    t.pass('Not testing local container registry because we\'re not running in KinD');
    return;
  }
  console.log('Creating local container registry...');
  await exec('docker run -d --restart=always -p "5000:5000" --name "kind-registry" registry:2');
  await exec('docker network connect "kind" "kind-registry"');

  console.log('Pushing python:rc-buster image to the local registry');
  //Note: this job takes a while and waitForJob() should be called before trying to access local registry image,
  //to make sure it completed
  await kubectl.applyK8sYaml('./test/fixtures/insecure-registries/push-dockerhub-image-to-local-registry.yaml');

  t.pass('successfully started a job to push image to a local registry');
});

tap.test('snyk-monitor sends data to kubernetes-upstream', async (t) => {
  t.plan(7);

  console.log(`Begin polling kubernetes-upstream for the expected workloads with integration ID ${integrationId}...`);

  const validatorFn: WorkloadLocatorValidator = (workloads) => {
    return workloads !== undefined && workloads.length === 6 &&
      workloads.find((workload) => workload.name === 'alpine' &&
        workload.type === WorkloadKind.Pod) !== undefined &&
      workloads.find((workload) => workload.name === 'nginx' &&
        workload.type === WorkloadKind.ReplicationController) !== undefined &&
      workloads.find((workload) => workload.name === 'redis' &&
        workload.type === WorkloadKind.Deployment) !== undefined &&
      workloads.find((workload) => workload.name === 'alpine-from-sha' &&
        workload.type === WorkloadKind.Pod) !== undefined &&
      workloads.find((workload) => workload.name === 'busybox' &&
        workload.type === WorkloadKind.Deployment) !== undefined &&
      workloads.find((workload) => workload.name === 'centos' &&
        workload.type === WorkloadKind.Deployment) !== undefined;
  };

  const metaValidator: WorkloadMetadataValidator = (workloadInfo) => {
    return workloadInfo !== undefined && 'revision' in workloadInfo && 'labels' in workloadInfo &&
      'specLabels' in workloadInfo && 'annotations' in workloadInfo && 'specAnnotations' in workloadInfo &&
      'podSpec' in workloadInfo;
  };

  // We don't want to spam kubernetes-upstream with requests; do it infrequently
  const depGraphTestResult = await validateUpstreamStoredData(
    validatorFn, `api/v2/workloads/${integrationId}/Default cluster/services`);
  t.ok(depGraphTestResult, 'snyk-monitor sent expected data to kubernetes-upstream in the expected timeframe');
  const workloadMetadataResult = await validateUpstreamStoredMetadata(metaValidator,
    `api/v1/workload/${integrationId}/Default cluster/services/Deployment/redis`);
  t.ok(workloadMetadataResult, 'snyk-monitor sent expected metadata in the expected timeframe');

  const busyboxDepGraphPath = `api/v1/dependency-graphs/${integrationId}/Default%20cluster/services/Deployment/busybox`;
  const depGraphScratchImage = await getUpstreamResponseBody(busyboxDepGraphPath);
  t.ok('dependencyGraphResults' in depGraphScratchImage, 'upstream response contains dep graph results');
  t.ok('busybox' in depGraphScratchImage.dependencyGraphResults, 'busybox was scanned');
  const busyboxPluginResult = JSON.parse(depGraphScratchImage.dependencyGraphResults.busybox);
  t.same(busyboxPluginResult.package.packageFormatVersion, 'linux:0.0.1', 'the version of the package format');
  t.same(busyboxPluginResult.package.targetOS, {name: 'unknown', version: '0.0', prettyName: ''}, 'busybox operating system unknown');
  t.same(busyboxPluginResult.plugin.packageManager, 'linux', 'linux is the default package manager for scratch containers');
});

tap.test('snyk-monitor sends binary hashes to kubernetes-upstream after adding another deployment', async (t) => {
  t.plan(10);

  const deploymentName = 'binaries-deployment';
  const namespace = 'services';
  const clusterName = 'Default cluster';
  const deploymentType = WorkloadKind.Deployment;

  await kubectl.applyK8sYaml('./test/fixtures/binaries-deployment.yaml');
  console.log(`Begin polling kubernetes-upstream for the expected workloads with integration ID ${integrationId}...`);

  const workloadLocatorValidatorFn: WorkloadLocatorValidator = (workloads) => {
    return workloads !== undefined &&
      workloads.find((workload) => workload.name === deploymentName &&
        workload.type === WorkloadKind.Deployment) !== undefined;
  };

  const depGraphsValidatorFn = (depGraphs?: {
    node?: object;
    openjdk?: object;
  }) => {
    return (
      depGraphs !== undefined &&
      depGraphs.node !== undefined &&
      depGraphs.openjdk !== undefined
    );
  };

  const testResult = await validateUpstreamStoredData(
    workloadLocatorValidatorFn, `api/v2/workloads/${integrationId}/${clusterName}/${namespace}`);
  t.ok(testResult, 'snyk-monitor sent expected data to kubernetes-upstream in the expected timeframe');

  const depGraphsResult = await validateUpstreamStoredDepGraphs(
    depGraphsValidatorFn, `api/v1/dependency-graphs/${integrationId}/${clusterName}/${namespace}/${deploymentType}/${deploymentName}`
  );
  t.ok(depGraphsResult, 'snyk-monitor sent expected dependency graphs to kubernetes-upstream in the expected timeframe');

  const depGraphResult = await getUpstreamResponseBody(
    `api/v1/dependency-graphs/${integrationId}/${clusterName}/${namespace}/${deploymentType}/${deploymentName}`);
  t.ok('dependencyGraphResults' in depGraphResult,
    'expected dependencyGraphResults field to exist in /dependency-graphs response');

  const nodePluginResult = JSON.parse(depGraphResult.dependencyGraphResults.node);
  t.ok('imageMetadata' in nodePluginResult,
    'snyk-monitor sent expected data to kubernetes-upstream in the expected timeframe');
  t.ok('hashes' in nodePluginResult, 'snyk-docker-plugin contains key-binary hashes');
  t.equals(nodePluginResult.hashes.length, 1, 'one key-binary hash found in node image');
  t.equals(
    nodePluginResult.hashes[0],
    '6d5847d3cd69dfdaaf9dd2aa8a3d30b1a9b3bfa529a1f5c902a511e1aa0b8f55',
    'SHA256 for whatever Node is on node:lts-alpine3.11',
  );

  const openjdkPluginResult = JSON.parse(depGraphResult.dependencyGraphResults.openjdk);
  t.ok('hashes' in openjdkPluginResult, 'snyk-docker-plugin contains key-binary hashes');
  t.equals(openjdkPluginResult.hashes.length, 2, 'two openjdk hashes found in node image');
  const expectedHashes = [
    '99503bfc6faed2da4fd35f36a5698d62676f886fb056fb353064cc78b1186195',
    '00a90dcce9ca53be1630a21538590cfe15676f57bfe8cf55de0099ee80bbeec4'
  ];
  t.deepEquals(
    openjdkPluginResult.hashes,
    expectedHashes,
    'hashes for openjdk found',
  );
});

tap.test('snyk-monitor pulls images from a private gcr.io registry and sends data to kubernetes-upstream', async (t) => {
  t.plan(3);

  const deploymentName = 'debian-gcr-io';
  const namespace = 'services';
  const clusterName = 'Default cluster';
  const deploymentType = WorkloadKind.Deployment;
  const imageName = 'gcr.io/snyk-k8s-fixtures/debian';

  await kubectl.applyK8sYaml('./test/fixtures/private-registries/debian-deployment-gcr-io.yaml');
  console.log(`Begin polling upstream for the expected private gcr.io image with integration ID ${integrationId}...`);

  const validatorFn: WorkloadLocatorValidator = (workloads) => {
    return workloads !== undefined &&
      workloads.find((workload) => workload.name === deploymentName &&
        workload.type === WorkloadKind.Deployment) !== undefined;
  };

  const testResult = await validateUpstreamStoredData(
    validatorFn, `api/v2/workloads/${integrationId}/${clusterName}/${namespace}`);
  t.ok(testResult, 'snyk-monitor sent expected data to upstream in the expected timeframe');

  const depGraphResult = await getUpstreamResponseBody(
    `api/v1/dependency-graphs/${integrationId}/${clusterName}/${namespace}/${deploymentType}/${deploymentName}`);
  t.ok('dependencyGraphResults' in depGraphResult,
    'expected dependencyGraphResults field to exist in /dependency-graphs response');
  t.ok('imageMetadata' in JSON.parse(depGraphResult.dependencyGraphResults[imageName]),
    'snyk-monitor sent expected data to upstream in the expected timeframe');
});

tap.test('snyk-monitor pulls images from a private ECR and sends data to kubernetes-upstream', async (t) => {
  if (process.env['TEST_PLATFORM'] !== 'eks') {
    t.pass('Not testing private ECR images because we\'re not running in EKS');
    return;
  }

  t.plan(3);

  const deploymentName = 'debian-ecr';
  const namespace = 'services';
  const clusterName = 'Default cluster';
  const deploymentType = WorkloadKind.Deployment;
  const imageName = '291964488713.dkr.ecr.us-east-2.amazonaws.com/snyk/debian';

  await kubectl.applyK8sYaml('./test/fixtures/private-registries/debian-deployment-ecr.yaml');
  console.log(`Begin polling upstream for the expected private ECR image with integration ID ${integrationId}...`);

  const validatorFn: WorkloadLocatorValidator = (workloads) => {
    return workloads !== undefined &&
      workloads.find((workload) => workload.name === deploymentName &&
        workload.type === WorkloadKind.Deployment) !== undefined;
  };

  const testResult = await validateUpstreamStoredData(
    validatorFn, `api/v2/workloads/${integrationId}/${clusterName}/${namespace}`);
  t.ok(testResult, 'snyk-monitor sent expected data to upstream in the expected timeframe');

  const depGraphResult = await getUpstreamResponseBody(
    `api/v1/dependency-graphs/${integrationId}/${clusterName}/${namespace}/${deploymentType}/${deploymentName}`);
  t.ok('dependencyGraphResults' in depGraphResult,
    'expected dependencyGraphResults field to exist in /dependency-graphs response');
  t.ok('imageMetadata' in JSON.parse(depGraphResult.dependencyGraphResults[imageName]),
    'snyk-monitor sent expected data to upstream in the expected timeframe');
});

tap.test('snyk-monitor pulls images from a local registry and sends data to kubernetes-upstream', async (t) => {
  t.teardown(async () => {
    console.log('Begin removing local container registry...');
    await setup.removeLocalContainerRegistry();
    console.log('Removed local container registry');
  });

  if (process.env['TEST_PLATFORM'] !== 'kind') {
    t.pass('Not testing local container registry because we\'re not running in KinD');
    return;
  }
  t.plan(3);

  const deploymentName = 'python-local';
  const namespace = 'services';
  const clusterName = 'Default cluster';
  const deploymentType = WorkloadKind.Deployment;
  const imageName = 'kind-registry:5000/python';

  await kubectl.waitForJob('push-to-local-registry', 'default');

  console.log('Applying local registry workload...');
  await kubectl.applyK8sYaml('./test/fixtures/insecure-registries/python-local-deployment.yaml');

  console.log(`Begin polling upstream for the expected kind-registry:5000 image with integration ID ${integrationId}...`);

  const validatorFn: WorkloadLocatorValidator = (workloads) => {
    return workloads !== undefined &&
      workloads.find((workload) => workload.name === deploymentName &&
        workload.type === deploymentType) !== undefined;
  };

  const testResult = await validateUpstreamStoredData(
    validatorFn, `api/v2/workloads/${integrationId}/${clusterName}/${namespace}`);
  t.ok(testResult, 'snyk-monitor sent expected data to upstream in the expected timeframe');

  const depGraphResult = await getUpstreamResponseBody(
    `api/v1/dependency-graphs/${integrationId}/${clusterName}/${namespace}/${deploymentType}/${deploymentName}`);

  t.ok('dependencyGraphResults' in depGraphResult,
  'expected dependencyGraphResults field to exist in /dependency-graphs response');
  t.ok('imageMetadata' in JSON.parse(depGraphResult.dependencyGraphResults[imageName]),
    'snyk-monitor sent expected data to upstream in the expected time frame');
});

tap.test('snyk-monitor sends deleted workload to kubernetes-upstream', async (t) => {
  // First ensure the deployment exists from the previous test
  const deploymentValidatorFn: WorkloadLocatorValidator = (workloads) => {
    return workloads !== undefined &&
      workloads.find((workload) => workload.name === 'binaries-deployment' &&
        workload.type === WorkloadKind.Deployment) !== undefined;
  };

  const testResult = await validateUpstreamStoredData(deploymentValidatorFn,
    `api/v2/workloads/${integrationId}/Default cluster/services`);
  t.ok(testResult, 'snyk-monitor sent expected data to kubernetes-upstream in the expected timeframe');

  const deploymentName = 'binaries-deployment';
  const namespace = 'services';
  await kubectl.deleteDeployment(deploymentName, namespace);

  // Finally, remove the workload and ensure that the snyk-monitor notifies kubernetes-upstream
  const deleteValidatorFn: WorkloadLocatorValidator = (workloads) => {
    return workloads !== undefined && workloads.every((workload) => workload.name !== 'binaries-deployment');
  };

  const clusterName = 'Default cluster';
  const deleteTestResult = await validateUpstreamStoredData(deleteValidatorFn,
    `api/v2/workloads/${integrationId}/${clusterName}/${namespace}`);
  t.ok(deleteTestResult, 'snyk-monitor sent deleted workload data to kubernetes-upstream in the expected timeframe');
});

tap.test('snyk-monitor has resource limits', async (t) => {
  t.plan(5);
  const snykMonitorDeployment = await kubectl.getDeploymentJson('snyk-monitor', namespace);
  const monitorResources = snykMonitorDeployment.spec.template.spec.containers[0].resources;

  t.ok(monitorResources !== undefined, 'snyk-monitor has resources');
  t.ok(monitorResources.requests.cpu !== undefined, 'snyk-monitor has cpu resource request');
  t.ok(monitorResources.requests.memory !== undefined, 'snyk-monitor has memory resource request');
  t.ok(monitorResources.requests.cpu !== undefined, 'snyk-monitor has cpu resource request');
  t.ok(monitorResources.requests.memory !== undefined, 'snyk-monitor has memory resource request');
});

tap.test('snyk-monitor has log level', async(t) => {
  if (!['Helm', 'YAML'].includes(process.env.DEPLOYMENT_TYPE || '')) {
    t.pass('Not testing LOG_LEVEL existence because we\'re not installing with Helm or Yaml');
    return;
  }

  const snykMonitorDeployment = await kubectl.getDeploymentJson('snyk-monitor', namespace);
  const env = snykMonitorDeployment.spec.template.spec.containers[0].env;
  const logLevel = env.find(({ name }) => name === 'LOG_LEVEL');

  t.ok(logLevel.name, 'snyk-monitor has log level variable');
  t.ok(logLevel.value, 'snyk-monitor has log level value');
});

tap.test('snyk-monitor has nodeSelector', async (t) => {
  t.plan(1);

  if (process.env['DEPLOYMENT_TYPE'] !== 'Helm') {
    t.pass('Not testing nodeSelector because we\'re not installing with Helm');
    return;
  }

  const snykMonitorDeployment = await kubectl.getDeploymentJson('snyk-monitor', 'snyk-monitor');
  const spec = snykMonitorDeployment.spec.template.spec;

  t.ok('nodeSelector' in spec, 'snyk-monitor has nodeSelector');
});

tap.test('snyk-monitor has PodSecurityPolicy', async (t) => {
  t.plan(1);

  if (process.env['DEPLOYMENT_TYPE'] !== 'Helm') {
    t.pass('Not testing PodSecurityPolicy because we\'re not installing with Helm');
    return;
  }

  const pspExists = await kubectl.verifyPodSecurityPolicy('snyk-monitor');
  t.ok(pspExists, 'PodSecurityPolicy was deployed');
});

tap.test('snyk-monitor secure configuration is as expected', async (t) => {
  const kubeConfig = new KubeConfig();
  kubeConfig.loadFromDefault();
  const k8sApi = kubeConfig.makeApiClient(AppsV1Api);

  const response = await k8sApi.readNamespacedDeployment(
    'snyk-monitor',
    namespace,
  );
  const deployment = response.body;

  validateSecureConfiguration(t, deployment);
  validateVolumeMounts(t, deployment);
  validateEnvironmentVariables(t, deployment);
});

/**
 * The snyk-monitor should detect that a Pod which doesn't have
 * a parent (OwnerReference) is deleted and should notify upstream.
 *
 * This is the only special case of a workload, where the Pod
 * itself is the workload (because it was created on its own).
 */
tap.test('notify upstream of deleted pods that have no OwnerReference', async (t) => {
  const clusterName = 'Default cluster';

  const podName = 'alpine';
  const namespace = 'services';

  await kubectl.deletePod(podName, namespace);

  const validatorFn: WorkloadLocatorValidator = (workloads) => {
    return (
      workloads !== undefined &&
      workloads.find(
        (workload) => workload.name === 'alpine' && workload.type === WorkloadKind.Pod,
      ) === undefined
    );
  };

  const validationResult = await validateUpstreamStoredData(
    validatorFn,
    `api/v2/workloads/${integrationId}/${clusterName}/${namespace}`,
  );
  t.ok(
    validationResult,
    'snyk-monitor sends deleted workloads to upstream for pods without OwnerReference',
  );
});
