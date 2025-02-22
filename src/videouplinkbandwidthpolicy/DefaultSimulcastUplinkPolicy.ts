// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Logger from '../logger/Logger';
import AsyncScheduler from '../scheduler/AsyncScheduler';
import SimulcastLayers from '../simulcastlayers/SimulcastLayers';
import SimulcastTransceiverController from '../transceivercontroller/SimulcastTransceiverController';
import { Maybe } from '../utils/Types';
import DefaultVideoAndEncodeParameter from '../videocaptureandencodeparameter/DefaultVideoCaptureAndEncodeParameter';
import VideoStreamDescription from '../videostreamindex/VideoStreamDescription';
import VideoStreamIndex from '../videostreamindex/VideoStreamIndex';
import BitrateParameters from './BitrateParameters';
import ConnectionMetrics from './ConnectionMetrics';
import SimulcastUplinkObserver from './SimulcastUplinkObserver';
import SimulcastUplinkPolicy from './SimulcastUplinkPolicy';

const enum ActiveStreams {
  kHi,
  kHiAndLow,
  kMidAndLow,
  kLow,
}

/**
 * [[DefaultSimulcastUplinkPolicy]] determines capture and encode
 *  parameters that reacts to estimated uplink bandwidth
 */
export default class DefaultSimulcastUplinkPolicy implements SimulcastUplinkPolicy {
  static readonly defaultUplinkBandwidthKbps: number = 1200;
  static readonly startupDurationMs: number = 6000;
  static readonly holdDownDurationMs: number = 4000;
  static readonly defaultMaxFrameRate = 15;
  // Current rough estimates where webrtc disables streams
  static readonly kHiDisabledRate = 700;
  static readonly kMidDisabledRate = 240;

  private numSenders: number = 0;
  // Simulcast is disabled when there are only 2 or fewer attendees, because in that case the backend will forward REMBs from
  // receiver to sender. Therefore there is no need for simulcast based adaption.
  private shouldDisableSimulcast: boolean = false;
  private optimalParameters: DefaultVideoAndEncodeParameter;
  private parametersInEffect: DefaultVideoAndEncodeParameter;
  private newQualityMap = new Map<string, RTCRtpEncodingParameters>();
  private currentQualityMap = new Map<string, RTCRtpEncodingParameters>();
  private newActiveStreams: ActiveStreams = ActiveStreams.kHiAndLow;
  private currentActiveStreams: ActiveStreams = ActiveStreams.kHiAndLow;
  private lastUplinkBandwidthKbps: number = DefaultSimulcastUplinkPolicy.defaultUplinkBandwidthKbps;
  private startTimeMs: number = 0;
  private lastUpdatedMs: number = Date.now();
  private videoIndex: VideoStreamIndex | null = null;
  private currLocalDescriptions: VideoStreamDescription[] = [];
  private nextLocalDescriptions: VideoStreamDescription[] = [];
  private activeStreamsToPublish: ActiveStreams;
  private observerQueue: Set<SimulcastUplinkObserver> = new Set<SimulcastUplinkObserver>();

  constructor(private selfAttendeeId: string, private logger: Logger) {
    this.optimalParameters = new DefaultVideoAndEncodeParameter(0, 0, 0, 0, true);
    this.parametersInEffect = new DefaultVideoAndEncodeParameter(0, 0, 0, 0, true);
    this.lastUplinkBandwidthKbps = DefaultSimulcastUplinkPolicy.defaultUplinkBandwidthKbps;
    this.currentQualityMap = this.fillEncodingParamWithBitrates([300, 0, 1200]);
    this.newQualityMap = this.fillEncodingParamWithBitrates([300, 0, 1200]);
  }

  updateConnectionMetric({ uplinkKbps = 0 }: ConnectionMetrics): void {
    if (isNaN(uplinkKbps)) {
      return;
    }

    // Check if startup period in order to ignore estimate when video first enabled.
    // If only audio was active then the estimate will be very low
    if (this.startTimeMs === 0) {
      this.startTimeMs = Date.now();
    }
    if (Date.now() - this.startTimeMs < DefaultSimulcastUplinkPolicy.startupDurationMs) {
      this.lastUplinkBandwidthKbps = DefaultSimulcastUplinkPolicy.defaultUplinkBandwidthKbps;
    } else {
      this.lastUplinkBandwidthKbps = uplinkKbps;
    }
    this.logger.debug(() => {
      return `simulcast: uplink policy update metrics ${this.lastUplinkBandwidthKbps}`;
    });

    let holdTime = DefaultSimulcastUplinkPolicy.holdDownDurationMs;
    if (this.currentActiveStreams === ActiveStreams.kLow) {
      holdTime = DefaultSimulcastUplinkPolicy.holdDownDurationMs * 2;
    } else if (
      (this.currentActiveStreams === ActiveStreams.kMidAndLow &&
        uplinkKbps <= DefaultSimulcastUplinkPolicy.kMidDisabledRate) ||
      (this.currentActiveStreams === ActiveStreams.kHiAndLow &&
        uplinkKbps <= DefaultSimulcastUplinkPolicy.kHiDisabledRate)
    ) {
      holdTime = DefaultSimulcastUplinkPolicy.holdDownDurationMs / 2;
    }
    if (Date.now() < this.lastUpdatedMs + holdTime) {
      return;
    }

    this.newQualityMap = this.calculateEncodingParameters(false);
  }

  private calculateEncodingParameters(
    numSendersChanged: boolean
  ): Map<string, RTCRtpEncodingParameters> {
    // bitrates parameter min is not used for now
    const newBitrates: BitrateParameters[] = [
      new BitrateParameters(),
      new BitrateParameters(),
      new BitrateParameters(),
    ];

    let hysteresisIncrease = 0,
      hysteresisDecrease = 0;
    if (this.currentActiveStreams === ActiveStreams.kHi) {
      // Don't trigger redetermination based on rate if only one simulcast stream
      hysteresisIncrease = this.lastUplinkBandwidthKbps + 1;
      hysteresisDecrease = 0;
    } else if (this.currentActiveStreams === ActiveStreams.kHiAndLow) {
      hysteresisIncrease = 2400;
      hysteresisDecrease = DefaultSimulcastUplinkPolicy.kHiDisabledRate;
    } else if (this.currentActiveStreams === ActiveStreams.kMidAndLow) {
      hysteresisIncrease = 1000;
      hysteresisDecrease = DefaultSimulcastUplinkPolicy.kMidDisabledRate;
    } else {
      hysteresisIncrease = 300;
      hysteresisDecrease = 0;
    }

    if (
      numSendersChanged ||
      this.lastUplinkBandwidthKbps >= hysteresisIncrease ||
      this.lastUplinkBandwidthKbps <= hysteresisDecrease
    ) {
      if (this.shouldDisableSimulcast) {
        // See comment above `shouldDisableSimulcast` for usage.
        //
        // The value of `newActiveStreams` is somewhat irrelevant since in one to one calls
        // we forward REMBs, so this single stream will adapt anywhere from < 100 kbps to 1200 kbps
        // based on both sender and receiver network conditions. E.g. A receiver may calculate it's
        // receive BWE as 300 kbps, send that in a REMB which is forwarded, and on receipt the sender
        // will set its own BWE at 300 kbps, and start sending that as well (again, only for one-to-one
        // calls). Additionally the value `kHi` is only relevant to the send side (via
        // `encodingSimulcastLayersDidChange`) as it is not transmitted in anyform to the receiver.
        //
        // We use middle layer here to work around a bug in Chromium where
        // it seems when a transceiver is created when BWE is low (e.g. on a reconnection),
        // it will never reset the encoder even when `setParameters` is called.  WebRTC bug
        // #12788 seems to call a similar issue out as fixed for VP8, it's not clear if this
        // is the same issue for H.264. Additionally we are not able to force a keyframe
        // request from the backend since it will only be sending padding (which also
        // don't have MID due to #10822). Since we don't scale when simulcast is disabled
        // this doesn't have any end-user effect.
        //
        // Note that this still relies on a little bit (5-6 packets) of padding on reconnect
        // and that technically the browser will still eventually try to send all 3 streams.
        //
        // Also note that due to some uninvestigated logic in bitrate allocation, Chromium
        // will skip the bottom layer if we try setting it to 1200 kbps instead so it will
        // still take a while to recover (as it needs to send padding until it reaches around
        // 1000 kbps).
        this.newActiveStreams = ActiveStreams.kHi;
        newBitrates[0].maxBitrateKbps = 0;
        newBitrates[1].maxBitrateKbps = 1200;
        newBitrates[2].maxBitrateKbps = 0;
      } else if (
        this.numSenders <= 4 &&
        this.lastUplinkBandwidthKbps >= DefaultSimulcastUplinkPolicy.kHiDisabledRate
      ) {
        // 320x192+ (640x384)  + 1280x768
        this.newActiveStreams = ActiveStreams.kHiAndLow;
        newBitrates[0].maxBitrateKbps = 300;
        newBitrates[1].maxBitrateKbps = 0;
        newBitrates[2].maxBitrateKbps = 1200;
      } else if (this.lastUplinkBandwidthKbps >= DefaultSimulcastUplinkPolicy.kMidDisabledRate) {
        // 320x192 + 640x384 + (1280x768)
        this.newActiveStreams = ActiveStreams.kMidAndLow;
        newBitrates[0].maxBitrateKbps = this.lastUplinkBandwidthKbps >= 350 ? 200 : 150;
        newBitrates[1].maxBitrateKbps = this.numSenders <= 6 ? 600 : 350;
        newBitrates[2].maxBitrateKbps = 0;
      } else {
        // 320x192 + 640x384 + (1280x768)
        this.newActiveStreams = ActiveStreams.kLow;
        newBitrates[0].maxBitrateKbps = 300;
        newBitrates[1].maxBitrateKbps = 0;
        newBitrates[2].maxBitrateKbps = 0;
      }
      const bitrates: number[] = newBitrates.map((v, _i, _a) => {
        return v.maxBitrateKbps;
      });

      this.newQualityMap = this.fillEncodingParamWithBitrates(bitrates);
      if (!this.encodingParametersEqual()) {
        this.logger.info(
          `simulcast: policy:calculateEncodingParameters bw:${
            this.lastUplinkBandwidthKbps
          } numSources:${this.numSenders} shouldDisableSimulcast:${
            this.shouldDisableSimulcast
          } newQualityMap: ${this.getQualityMapString(this.newQualityMap)}`
        );
      }
    }
    return this.newQualityMap;
  }

  chooseMediaTrackConstraints(): MediaTrackConstraints {
    // Changing MediaTrackConstraints causes a restart of video input and possible small
    // scaling changes.  Always use 720p for now
    const trackConstraint: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 768 },
      frameRate: { ideal: 15 },
    };
    return trackConstraint;
  }

  chooseEncodingParameters(): Map<string, RTCRtpEncodingParameters> {
    this.currentQualityMap = this.newQualityMap;
    this.currentActiveStreams = this.newActiveStreams;
    if (this.activeStreamsToPublish !== this.newActiveStreams) {
      this.activeStreamsToPublish = this.newActiveStreams;
      this.publishEncodingSimulcastLayer();
    }
    return this.currentQualityMap;
  }

  updateIndex(videoIndex: VideoStreamIndex): void {
    // the +1 for self is assuming that we intend to send video, since
    // the context here is VideoUplinkBandwidthPolicy
    const numSenders =
      videoIndex.numberOfVideoPublishingParticipantsExcludingSelf(this.selfAttendeeId) + 1;
    const numSendersChanged = numSenders !== this.numSenders;

    // See comment above `shouldDisableSimulcast`
    const numParticipants = videoIndex.numberOfParticipants();
    const newShouldDisableSimulcast = numParticipants >= 0 && numParticipants <= 2;
    const shouldDisableSimulcastChanged = this.shouldDisableSimulcast !== newShouldDisableSimulcast;

    this.numSenders = numSenders;
    this.shouldDisableSimulcast = newShouldDisableSimulcast;
    this.optimalParameters = new DefaultVideoAndEncodeParameter(
      this.captureWidth(),
      this.captureHeight(),
      this.captureFrameRate(),
      this.maxBandwidthKbps(),
      false
    );
    this.videoIndex = videoIndex;
    this.newQualityMap = this.calculateEncodingParameters(
      numSendersChanged || shouldDisableSimulcastChanged
    );
  }

  wantsResubscribe(): boolean {
    let constraintDiff = !this.encodingParametersEqual();

    this.nextLocalDescriptions = this.videoIndex.localStreamDescriptions();
    for (let i = 0; i < this.nextLocalDescriptions.length; i++) {
      const streamId = this.nextLocalDescriptions[i].streamId;
      if (streamId !== 0 && !!streamId) {
        const prevIndex = this.currLocalDescriptions.findIndex(val => {
          return val.streamId === streamId;
        });
        if (prevIndex !== -1) {
          if (
            this.nextLocalDescriptions[i].disabledByWebRTC !==
            this.currLocalDescriptions[prevIndex].disabledByWebRTC
          ) {
            constraintDiff = true;
          }
        }
      }
    }

    if (constraintDiff) {
      this.lastUpdatedMs = Date.now();
    }

    this.currLocalDescriptions = this.nextLocalDescriptions;
    return constraintDiff;
  }

  private compareEncodingParameter(
    encoding1: RTCRtpEncodingParameters,
    encoding2: RTCRtpEncodingParameters
  ): boolean {
    return JSON.stringify(encoding1) === JSON.stringify(encoding2);
  }

  private encodingParametersEqual(): boolean {
    let different = false;
    for (const ridName of SimulcastTransceiverController.NAME_ARR_ASCENDING) {
      different =
        different ||
        !this.compareEncodingParameter(
          this.newQualityMap.get(ridName),
          this.currentQualityMap.get(ridName)
        );
      if (different) {
        break;
      }
    }

    return !different;
  }

  chooseCaptureAndEncodeParameters(): DefaultVideoAndEncodeParameter {
    // should deprecate in this policy
    this.parametersInEffect = this.optimalParameters.clone();
    return this.parametersInEffect.clone();
  }

  private captureWidth(): number {
    // should deprecate in this policy
    const width = 1280;
    return width;
  }

  private captureHeight(): number {
    // should deprecate in this policy
    const height = 768;
    return height;
  }

  private captureFrameRate(): number {
    // should deprecate in this policy
    return 15;
  }

  maxBandwidthKbps(): number {
    // should deprecate in this policy
    return 1400;
  }

  setIdealMaxBandwidthKbps(_idealMaxBandwidthKbps: number): void {
    // should deprecate in this policy
  }

  setHasBandwidthPriority(_hasBandwidthPriority: boolean): void {
    // should deprecate in this policy
  }

  private fillEncodingParamWithBitrates(
    bitratesKbps: number[]
  ): Map<string, RTCRtpEncodingParameters> {
    const newMap = new Map<string, RTCRtpEncodingParameters>();
    const toBps = 1000;
    const nameArr = SimulcastTransceiverController.NAME_ARR_ASCENDING;
    const bitrateArr = bitratesKbps;
    // Don't scale the single simulcast stream regardless of its layer.
    let scale = this.shouldDisableSimulcast ? 1 : 4;
    for (let i = 0; i < nameArr.length; i++) {
      const ridName = nameArr[i];
      newMap.set(ridName, {
        rid: ridName,
        active: bitrateArr[i] > 0 ? true : false,
        scaleResolutionDownBy: Math.max(scale, 1),
        maxBitrate: bitrateArr[i] * toBps,
      });
      scale = scale / 2;
    }

    return newMap;
  }

  private getQualityMapString(params: Map<string, RTCRtpEncodingParameters>): string {
    let qualityString = '';
    const localDescriptions = this.videoIndex.localStreamDescriptions();
    if (localDescriptions.length === 3) {
      params.forEach((value: RTCRtpEncodingParameters) => {
        let disabledByWebRTC = false;
        if (value.rid === 'low') disabledByWebRTC = localDescriptions[0].disabledByWebRTC;
        else if (value.rid === 'mid') disabledByWebRTC = localDescriptions[1].disabledByWebRTC;
        else disabledByWebRTC = localDescriptions[2].disabledByWebRTC;
        qualityString += `{ rid: ${value.rid} active:${value.active} disabledByWebRTC: ${disabledByWebRTC} maxBitrate:${value.maxBitrate}}`;
      });
    }
    return qualityString;
  }

  getEncodingSimulcastLayer(activeStreams: ActiveStreams): SimulcastLayers {
    switch (activeStreams) {
      case ActiveStreams.kHi:
        return SimulcastLayers.High;
      case ActiveStreams.kHiAndLow:
        return SimulcastLayers.LowAndHigh;
      case ActiveStreams.kMidAndLow:
        return SimulcastLayers.LowAndMedium;
      case ActiveStreams.kLow:
        return SimulcastLayers.Low;
    }
  }

  private publishEncodingSimulcastLayer(): void {
    const simulcastLayers = this.getEncodingSimulcastLayer(this.activeStreamsToPublish);
    this.forEachObserver(observer => {
      Maybe.of(observer.encodingSimulcastLayersDidChange).map(f =>
        f.bind(observer)(simulcastLayers)
      );
    });
  }

  addObserver(observer: SimulcastUplinkObserver): void {
    this.logger.info('adding simulcast uplink observer');
    this.observerQueue.add(observer);
  }

  removeObserver(observer: SimulcastUplinkObserver): void {
    this.logger.info('removing simulcast uplink observer');
    this.observerQueue.delete(observer);
  }

  forEachObserver(observerFunc: (observer: SimulcastUplinkObserver) => void): void {
    for (const observer of this.observerQueue) {
      AsyncScheduler.nextTick(() => {
        if (this.observerQueue.has(observer)) {
          observerFunc(observer);
        }
      });
    }
  }
}
