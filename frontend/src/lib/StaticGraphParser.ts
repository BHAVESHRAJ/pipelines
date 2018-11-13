/*
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as dagre from 'dagre';
import { Workflow, Template } from '../../third_party/argo-ui/argo_template';

interface ConditionalInfo {
  condition: string;
  taskName: string;
}

export type nodeType = 'container' | 'dag' | 'unknown';

export class SelectedNodeInfo {
  public args: string[];
  public command: string[];
  public condition: string;
  public conditionalTasks: ConditionalInfo[];
  public image: string;
  public inputs: string[][];
  public nodeType: nodeType;
  public outputs: string[][];

  constructor() {
    this.args = [];
    this.command = [];
    this.condition = '';
    this.conditionalTasks = [];
    this.image = '';
    this.inputs = [[]];
    this.nodeType = 'unknown';
    this.outputs = [[]];
  }
}


const NODE_WIDTH = 180;
const NODE_HEIGHT = 70;

function populateInfoFromTemplate(info: SelectedNodeInfo, template: Template): SelectedNodeInfo {
  if (!template.container) {
    return info;
  }

  info.nodeType = 'container';
  info.args = template.container.args || [],
  info.command = template.container.command || [],
  info.image = template.container.image || '';

  if (template.inputs) {
    info.inputs =
      (template.inputs.parameters || []).map(p => [p.name, p.value || '']);
  }
  if (template.outputs) {
    info.outputs = (template.outputs.parameters || []).map(p => {
      let value = '';
      if (p.value) {
        value = p.value;
      } else if (p.valueFrom) {
        value = p.valueFrom.jqFilter || p.valueFrom.jsonPath || p.valueFrom.parameter || p.valueFrom.path || '';
      }
      return [p.name, value];
    });
  }
  return info;
}

// TODO: handle recursive graphs.
//   Should just be able to pass "visitedNodes" set and check/ add to it.
function buildDag(
    graph: dagre.graphlib.Graph,
    entrypoint: string,
    templates: Map<string, { nodeType: nodeType, template: Template }>,
    parent?: string,): void {

  const root = templates.get(entrypoint);
  if (root && root.nodeType === 'dag') {
    const template = root.template;
    (template.dag.tasks || []).forEach((task) => {
      // tslint:disable-next-line:no-console
      console.log('task', task);
      // The compiler wraps the entire DAG in its own exit-handler if the user specifies one.
      // So we simply treat it as the root and work from there.
      if (task.name.startsWith('exit-handler')) {
        buildDag(graph, task.template, templates);
      } else {

        if (parent) {
          graph.setEdge(parent, task.name);
        }

        const info = new SelectedNodeInfo();
        if (task.when) {
          info.condition = task.when;
        }

        const child = templates.get(task.template);
        if (child) {
          if (child.nodeType === 'dag') {
            buildDag(graph, task.template, templates, task.name);
          } else if (child.nodeType === 'container' ) {
            populateInfoFromTemplate(info, child.template);
          } else {
            // TODO: handle?
          }
        }

        graph.setNode(task.name, {
          bgColor: task.when ? 'cornsilk' : undefined,
          height: NODE_HEIGHT,
          info,
          label: task.name,
          width: NODE_WIDTH,
        });
      }

      // DAG tasks can indicate dependencies which are graphically shown as parents with edges
      // pointing to their children (the task(s)).
      (task.dependencies || []).forEach((dep) => graph.setEdge(dep, task.name));
    });
  }
}

export function createGraph(workflow: Workflow): dagre.graphlib.Graph {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({});
  graph.setDefaultEdgeLabel(() => ({}));

  if (!workflow.spec || !workflow.spec.templates) {
    throw new Error('Could not generate graph. Provided Pipeline had no components.');
  }

  const workflowTemplates = workflow.spec.templates;

  const templates = new Map<string, { nodeType: nodeType, template: Template }>();

  // Iterate through the workflow's templates to construct the graph
  for (const template of workflowTemplates) {
    // TODO: do we need to check template here (and below)?
    // Argo allows specifying a single global exit handler. We also highlight that node.
    if (template.name === workflow.spec.onExit) {
      const info = new SelectedNodeInfo();
      populateInfoFromTemplate(info, template);
      graph.setNode(template.name, {
        bgColor: '#eee',
        height: NODE_HEIGHT,
        info,
        label: 'onExit - ' + template.name,
        width: NODE_WIDTH,
      });
    }

    if (template.container) {
      templates.set(template.name, { nodeType: 'container', template });
    } else if (template.dag) {
      templates.set(template.name, { nodeType: 'dag', template });
    } else {
      // Do nothing?
    }
  }

  buildDag(graph, workflow.spec.entrypoint, templates);

  // tslint:disable-next-line:no-console
  console.log(graph);

  // DSL-compiled Pipelines will always include a DAG, so they should never reach this point.
  // It is, however, possible for users to upload manually constructed Pipelines, and extremely
  // simple ones may have no steps or DAGs, just an entry point container.
  if (graph.nodeCount() === 0) {
    const entryPointTemplate = workflowTemplates.find((t) => t.name === workflow.spec.entrypoint);
    if (entryPointTemplate) {
      graph.setNode(entryPointTemplate.name, {
        height: NODE_HEIGHT,
        label: entryPointTemplate.name,
        width: NODE_WIDTH,
      });
    }
  }

  return graph;
}
