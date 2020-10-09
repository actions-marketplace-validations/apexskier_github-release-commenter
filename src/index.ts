import * as core from "@actions/core";
import * as github from "@actions/github";
import type * as Webhooks from "@octokit/webhooks";

const closesMatcher = /aria-label="This commit closes issue #(\d+)\."/g;

function* matchAll(re: RegExp, s: string) {
  let m;

  do {
    m = re.exec(s);
    if (m) {
      yield m;
    }
  } while (m);
}

(async function main() {
  try {
    const payload = github.context
      .payload as Webhooks.EventPayloads.WebhookPayloadRelease;

    const githubToken = core.getInput("GITHUB_TOKEN");
    const octokit = github.getOctokit(githubToken);

    // watch out, this is returning deleted releases for some reason
    const { data: releases } = await octokit.repos.listReleases({
      ...github.context.repo,
      per_page: 2,
    });

    const [currentRelease, priorRelease] = releases;

    const {
      data: { commits },
    } = await octokit.repos.compareCommits({
      ...github.context.repo,
      base: priorRelease.target_commitish,
      head: currentRelease.target_commitish,
    });

    const linkedIssuesPrs = new Set<string>();

    await Promise.all(
      commits.map((commit) => {
        (async () => {
          const response: {
            data: {
              resource: {
                messageBodyHTML: string;
                associatedPullRequests: {
                  edges: Array<{
                    node: {
                      title: string;
                      number: number;
                      timelineItems: {
                        nodes: Array<unknown>;
                      };
                    };
                  }>;
                };
              };
            };
          } = await octokit.graphql(`
          {
            resource(url: "${payload.repository.html_url}/commit/${commit.sha}") {
              ... on Commit {
                messageBodyHTML
                associatedPullRequests(first: 10) {
                  edges {
                    node {
                      title
                      number
                      timelineItems(itemTypes: [CONNECTED_EVENT, DISCONNECTED_EVENT], first: 100) {
                        nodes {
                          ... on ConnectedEvent {
                            id
                            subject {
                              ... on Issue {
                                number
                              }
                            }
                          }
                          ... on DisconnectedEvent {
                            id
                            subject {
                              ... on Issue {
                                number
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `);
          const body = response.data.resource.messageBodyHTML;
          for (const match in matchAll(closesMatcher, body)) {
            const [, num] = match;
            linkedIssuesPrs.add(num);
          }
        })();
      })
    );

    for (const issueNumber of linkedIssuesPrs) {
      octokit.issues.createComment({
        ...github.context.repo,
        issue_number: parseInt(issueNumber),
        body: `Released in [${currentRelease.name}](${currentRelease.html_url})`,
      });
    }
  } catch (error) {
    core.setFailed(error.message);
  }
})();
