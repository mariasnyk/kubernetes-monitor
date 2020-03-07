import { readFileSync, writeFileSync } from 'fs';
import { parse, stringify } from 'yaml';

import * as kubectl from '../../helpers/kubectl';
import { IDeployer } from './types';

export const yamlDeployer: IDeployer = {
  deploy: deployKubernetesMonitor,
};

async function deployKubernetesMonitor(
  integrationId: string,
  imageOpts: {
    imageNameAndTag: string;
    imagePullPolicy: string;
  },
): Promise<void> {
  const namespace = 'snyk-monitor';
  await kubectl.createNamespace(namespace);

  const secretName = 'snyk-monitor';
  const gcrDockercfg = process.env['GCR_IO_DOCKERCFG'] || '{}';
  await kubectl.createSecret(secretName, namespace, {
    'dockercfg.json': gcrDockercfg,
    integrationId,
  });

  const testYaml = 'snyk-monitor-test-deployment.yaml';
  createTestYamlDeployment(testYaml, imageOpts.imageNameAndTag, imageOpts.imagePullPolicy);

  await kubectl.applyK8sYaml('./snyk-monitor-cluster-permissions.yaml');
  await kubectl.applyK8sYaml('./snyk-monitor-test-deployment.yaml');
}

function createTestYamlDeployment(
  newYamlPath: string,
  imageNameAndTag: string,
  imagePullPolicy: string,
): void {
  console.log('Creating YAML snyk-monitor deployment...');
  const originalDeploymentYaml = readFileSync('./snyk-monitor-deployment.yaml', 'utf8');
  const deployment = parse(originalDeploymentYaml);

  deployment.spec.template.spec.containers[0].image = imageNameAndTag;
  deployment.spec.template.spec.containers[0].imagePullPolicy = imagePullPolicy;

  // Inject the baseUrl of kubernetes-upstream that snyk-monitor container use to send metadata
  deployment.spec.template.spec.containers[0].env[2] = {
    name: 'SNYK_INTEGRATION_API',
    value: 'https://kubernetes-upstream.dev.snyk.io',
  };

  // TODO: remove this hack once an Operator is used to deploy the snyk-monitor for OpenShift tests
  const testPlatform = process.env['TEST_PLATFORM'] || 'kind';
  if (testPlatform === 'openshift4') {
    delete deployment.spec.template.spec.containers[0].securityContext.runAsUser;
    delete deployment.spec.template.spec.containers[0].securityContext.runAsGroup;
  }

  writeFileSync(newYamlPath, stringify(deployment));
  console.log('Created YAML snyk-monitor deployment');
}
