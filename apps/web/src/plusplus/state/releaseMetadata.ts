import type { DesktopUpdateChannel } from "@t3tools/contracts";
import {
  type CliReleaseChannel,
  cliReleaseIndexPageUrl,
  cliReleaseMetadataUrl,
  decodeReleaseMetadata,
  newestCliReleaseVersion,
  type ReleaseMetadata,
} from "@t3tools/shared/cliRelease";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { Atom } from "effect/reactivity";
import type * as AsyncResult from "effect/reactivity/AsyncResult";

class ReleaseMetadataIndexError extends Schema.TaggedError<ReleaseMetadataIndexError>()(
  "ReleaseMetadataIndexError",
  {},
) {
  override get message(): string {
    return "GitHub releases response was not a list.";
  }
}

class ReleaseMetadataUnavailableError extends Schema.TaggedError<ReleaseMetadataUnavailableError>()(
  "ReleaseMetadataUnavailableError",
  { version: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Release v${this.version} metadata is unusable: ${this.reason}.`;
  }
}

/** GitHub lists at most 100 releases per page; ten pages is well past the channel gap. */
const DISCOVERY_PAGE_LIMIT = 10;

/** The track dialog waits on these requests, so a stalled connection must fail instead. */
const RELEASE_REQUEST_TIMEOUT = Duration.seconds(10);

/** GitHub rejects the CORS preflight a trace header triggers, so no request here propagates one. */
const getFromGithub = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.timeout(RELEASE_REQUEST_TIMEOUT),
  );

function updateChannelToReleaseChannel(channel: DesktopUpdateChannel): CliReleaseChannel {
  return channel === "nightly" ? "nightly" : "stable";
}

const findNewestVersion = Effect.fn("releaseMetadata.findNewestVersion")(
  (channel: CliReleaseChannel) =>
    Effect.gen(function* () {
      for (let page = 1; page <= DISCOVERY_PAGE_LIMIT; page += 1) {
        const response = yield* getFromGithub(cliReleaseIndexPageUrl(page));
        const releases = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap((ok) => ok.json),
        );
        if (!Array.isArray(releases)) {
          return yield* new ReleaseMetadataIndexError();
        }
        const version = newestCliReleaseVersion(releases, channel);
        if (version !== undefined) return version;
      }
      return null;
    }),
);

/** The selected release must carry decodable metadata; a missing or malformed asset fails so
 * callers fail closed instead of acting on an unverified release or an older one. */
const fetchSelectedMetadata = Effect.fn("releaseMetadata.fetchSelectedMetadata")(
  (version: string) =>
    Effect.gen(function* () {
      const response = yield* getFromGithub(cliReleaseMetadataUrl(version));
      if (response.status === 404) {
        return yield* new ReleaseMetadataUnavailableError({
          version,
          reason: "the metadata asset is missing",
        });
      }
      const json = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.text),
      );
      const metadata = decodeReleaseMetadata(`v${version}`, json);
      if (metadata._tag === "None") {
        return yield* new ReleaseMetadataUnavailableError({
          version,
          reason: "the metadata asset is malformed",
        });
      }
      return metadata.value;
    }),
);

/** Metadata for the newest GitHub release on the channel's track. Null when no release
 * exists there; a failure when the selected release's metadata asset is missing or malformed.
 * Refreshes only while mounted. */
export const releaseMetadataAtom = Atom.family((channel: DesktopUpdateChannel) =>
  Atom.make(
    Effect.gen(function* () {
      const version = yield* findNewestVersion(updateChannelToReleaseChannel(channel));
      if (version === null) return null;
      return yield* fetchSelectedMetadata(version);
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ).pipe(Atom.withRefresh("5 minutes"), Atom.withLabel(`release-metadata:${channel}`)),
);

export type { ReleaseMetadata };
export type ReleaseMetadataResult = AsyncResult.AsyncResult<ReleaseMetadata | null>;
