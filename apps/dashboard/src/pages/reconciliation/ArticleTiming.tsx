import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
type Row = Record<string, any>;
const names: Record<string, string> = { google: "Google News", exa: "Exa" };
const number = (v: number) => new Intl.NumberFormat("en-US").format(v);
const time = (v: number | null) => v ? new Date(v).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—";
const delta = (v: number | null) => {
  if (v == null) return "Unknown";
  const seconds = Math.round(Math.abs(v) / 1000);
  const value =
    seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${(seconds / 60).toFixed(1)}m`
        : `${(seconds / 3600).toFixed(1)}h`;
  return `${v < 0 ? "−" : "+"}${value}`;
};
export default function ArticleTiming({ data, matches, setMatches, page, setPage, loading }: {
  data: Row | null; matches: string; setMatches: (value: string) => void;
  page: number; setPage: (value: number) => void; loading: boolean;
}) {
  const groups = data?.groups || [];
  return (
          <section className="reconcile-panel" id="article-timing">
            <div className="panel-heading">
              <div>
                <h2>Article timing</h2>
                <p>
                  Compare provider publication and observation with our
                  completed fetch. All times UTC.
                </p>
              </div>
              <label className="timing-filter">
                Show
                <select
                  value={matches}
                  onChange={(e) => {
                    setMatches(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">All articles</option>
                  <option value="matched">Matched articles</option>
                  <option value="unmatched">Not matched</option>
                </select>
              </label>
            </div>
            <p className="timing-note">
              First observed is when our poll saw the result, not when the
              provider indexed it. Publication dates are provider-reported.
              Negative differences mean our fetch finished earlier than that
              timestamp.
            </p>
            <div className="reconcile-timings">
              {groups.length ? (
                groups.map((g: Row) => (
                  <details key={g.key} className="timing-article">
                    <summary>
                      <div>
                        <strong>{g.title || g.url}</strong>
                        <small>
                          {g.site} · Fetched:{" "}
                          {time(g.crawler_fetch_finished_at)} · First observed:{" "}
                          {time(g.observed_at)}
                        </small>
                      </div>
                      <Badge variant="outline">
                        {g.match === "url"
                          ? "URL match"
                          : g.match === "title"
                            ? "Probable title match"
                            : g.ambiguous
                              ? "Ambiguous title"
                              : g.observed_at > data!.generatedAt - 1800000
                                ? "Catching up"
                                : "Not matched"}
                      </Badge>
                    </summary>
                    <div className="timing-body">
                      <div className="timing-links">
                        <a href={g.url} target="_blank" rel="noreferrer">
                          Provider result <ExternalLink size={12} />
                        </a>
                        {g.article_url && (
                          <a
                            href={g.article_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Matched article <ExternalLink size={12} />
                          </a>
                        )}
                        {g.crawler_request_id && (
                          <a
                            href={`/api/requests/${g.crawler_request_id}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Fetch record #{g.crawler_request_id}
                          </a>
                        )}
                      </div>
                      <dl className="crawler-times">
                        <div>
                          <dt>Our fetch finished</dt>
                          <dd>{time(g.crawler_fetch_finished_at)}</dd>
                          <small>
                            {g.crawler_fetch_time_source === "worker_receipt"
                              ? "Worker receipt"
                              : g.crawler_fetch_time_source ===
                                  "legacy_request_finished"
                                ? "Legacy request record"
                                : "No linked successful fetch record"}
                          </small>
                        </div>
                        <div>
                          <dt>Our parse finished</dt>
                          <dd>{time(g.crawler_parsed_at)}</dd>
                        </div>
                        {g.crawler_reprocessed_at && <div><dt>Archive repaired</dt><dd>{time(g.crawler_reprocessed_at)}</dd></div>}
                        <div>
                          <dt>Publication in our article</dt>
                          <dd>{time(g.crawler_published_at)}</dd>
                        </div>
                      </dl>
                      <div className="reconcile-table">
                        <table>
                          <thead>
                            <tr>
                              <th>Provider</th>
                              <th>Published</th>
                              <th>First observed by us</th>
                              <th>Fetch − publication</th>
                              <th>Fetch − observation</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(g.provider_timings || []).map((t: Row) => (
                              <tr key={t.sighting_id}>
                                <td>
                                  {names[t.provider]}
                                  <small>First poll #{t.first_run_id}</small>
                                </td>
                                <td>{time(t.published_at)}</td>
                                <td>
                                  {time(t.observed_at)}
                                  <small>
                                    Last observed {time(t.last_observed_at)}
                                  </small>
                                </td>
                                <td>{delta(t.fetch_minus_published_ms)}</td>
                                <td>{delta(t.fetch_minus_observed_ms)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="timing-note">
                        Exact provider indexing time: not supplied. Publication
                        and observation timestamps stay separate for each
                        provider.
                        {g.match === "title" &&
                          " This is a probable title/date match, not a verified URL match."}
                        {g.audit &&
                          ` Audit: ${g.audit.status ? "HTTP " + g.audit.status : g.audit.state}.`}
                      </p>
                    </div>
                  </details>
                ))
              ) : (
                <div className="reconcile-empty">
                  No articles match these filters.
                </div>
              )}
            </div>
            <div className="timing-pagination">
              <span>
                {number(data?.groupCount || 0)} articles · Page {page} of{" "}
                {Math.max(1, data?.pageCount || 0)}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={loading || page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={loading || page >= (data?.pageCount || 0)}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </section>
  );
}
