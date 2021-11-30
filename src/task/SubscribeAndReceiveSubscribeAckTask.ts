// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import AudioVideoControllerState from '../audiovideocontroller/AudioVideoControllerState';
import MeetingSessionStatus from '../meetingsession/MeetingSessionStatus';
import MeetingSessionStatusCode from '../meetingsession/MeetingSessionStatusCode';
import DefaultSDP from '../sdp/DefaultSDP';
import SignalingClient from '../signalingclient/SignalingClient';
import SignalingClientEvent from '../signalingclient/SignalingClientEvent';
import SignalingClientEventType from '../signalingclient/SignalingClientEventType';
import SignalingClientSubscribe from '../signalingclient/SignalingClientSubscribe';
import SignalingClientObserver from '../signalingclientobserver/SignalingClientObserver';
import {
  SdkSignalFrame,
  SdkStreamServiceType,
  SdkSubscribeAckFrame,
} from '../signalingprotocol/SignalingProtocol.js';
import TaskCanceler from '../taskcanceler/TaskCanceler';
import BaseTask from './BaseTask';

/**
 * [[SubscribeAndReceiveSubscribeAckTask]] sends a subscribe frame with the given settings
 * and receives SdkSubscribeAckFrame.
 */
export default class SubscribeAndReceiveSubscribeAckTask extends BaseTask {
  protected taskName = 'SubscribeAndReceiveSubscribeAckTask';

  private taskCanceler: TaskCanceler | null = null;

  constructor(private context: AudioVideoControllerState) {
    super(context.logger);
  }

  cancel(): void {
    if (this.taskCanceler) {
      this.taskCanceler.cancel();
      this.taskCanceler = null;
    }
  }

  async run(): Promise<void> {
    let localSdp = '';
    if (this.context.peer && this.context.peer.localDescription) {
      if (this.context.browserBehavior.requiresUnifiedPlanMunging()) {
        localSdp = new DefaultSDP(this.context.peer.localDescription.sdp).withUnifiedPlanFormat()
          .sdp;
      } else {
        localSdp = this.context.peer.localDescription.sdp;
      }
    }

    if (!this.context.enableSimulcast) {
      // backward compatibility
      let frameRate = 0;
      let maxEncodeBitrateKbps = 0;
      if (this.context.videoCaptureAndEncodeParameter) {
        frameRate = this.context.videoCaptureAndEncodeParameter.captureFrameRate();
        maxEncodeBitrateKbps = this.context.videoCaptureAndEncodeParameter.encodeBitrates()[0];
      }
      const param: RTCRtpEncodingParameters = {
        rid: 'hi',
        maxBitrate: maxEncodeBitrateKbps * 1000,
        maxFramerate: frameRate,
        active: true,
      };

      this.context.videoStreamIndex.integrateUplinkPolicyDecision([param]);
    }

    this.context.videoStreamIndex.subscribeFrameSent();

    // See comment above `fixUpSubscriptionOrder`
    const videoSubscriptions = this.context.browserBehavior.requiresUnifiedPlan()
      ? this.fixUpSubscriptionOrder(localSdp, this.context.videoSubscriptions)
      : this.context.videoSubscriptions;

    const isSendingStreams: boolean =
      this.context.videoDuplexMode === SdkStreamServiceType.TX ||
      this.context.videoDuplexMode === SdkStreamServiceType.DUPLEX;
    this.context.previousSdpOffer = new DefaultSDP(localSdp);
    const subscribe = new SignalingClientSubscribe(
      this.context.meetingSessionConfiguration.credentials.attendeeId,
      localSdp,
      this.context.meetingSessionConfiguration.urls.audioHostURL,
      this.context.realtimeController.realtimeIsLocalAudioMuted(),
      false,
      videoSubscriptions,
      isSendingStreams,
      this.context.videoStreamIndex.localStreamDescriptions(),
      // TODO: handle check-in mode, or remove this param
      true
    );
    this.context.logger.info(`sending subscribe: ${JSON.stringify(subscribe)}`);
    this.context.signalingClient.subscribe(subscribe);

    const subscribeAckFrame = await this.receiveSubscribeAck();
    this.context.logger.info(`got subscribe ack: ${JSON.stringify(subscribeAckFrame)}`);
    this.context.sdpAnswer = subscribeAckFrame.sdpAnswer;
    this.context.videoStreamIndex.integrateSubscribeAckFrame(subscribeAckFrame);
  }

  // Our backends currently expect the video subscriptions passed in subscribe to precisely
  // line up with the media sections, with a zero for any video send or inactive section.
  //
  // Firefox occasionally tosses stopped transceivers at the end of the SDP without reason
  // and in general we don't want to be at the mercy of SDP sections not being in the same
  // order as `getTransceivers`, so we simply recalculate the array here to enforce that
  // expected invarient.
  private fixUpSubscriptionOrder(sdp: string, videoSubscriptions: number[]): number[] {
    const subscriptionsWithoutZero = videoSubscriptions.filter((value: number) => value !== 0);
    let subscriptionsWithoutZeroIndex = 0;

    const directions = new DefaultSDP(sdp).videoSectionDirections();
    const newSubscriptions: number[] = [];
    for (const direction of directions) {
      if (direction === 'recvonly') {
        if (subscriptionsWithoutZeroIndex >= subscriptionsWithoutZero.length) {
          this.context.logger.warn(
            `More receive sections (>${subscriptionsWithoutZeroIndex}) then subscriptions (${subscriptionsWithoutZero.length})`
          );
          newSubscriptions.push(0);
          continue;
        }
        newSubscriptions.push(subscriptionsWithoutZero[subscriptionsWithoutZeroIndex]);
        subscriptionsWithoutZeroIndex += 1;
      } else {
        newSubscriptions.push(0);
      }
    }
    this.context.logger.info(
      `Fixed up ${JSON.stringify(videoSubscriptions)} to ${JSON.stringify(
        newSubscriptions
      )} (may be same))}`
    );
    return newSubscriptions;
  }

  private receiveSubscribeAck(): Promise<SdkSubscribeAckFrame> {
    return new Promise((resolve, reject) => {
      const context = this.context;
      class Interceptor implements SignalingClientObserver, TaskCanceler {
        constructor(private signalingClient: SignalingClient) {}

        cancel(): void {
          this.signalingClient.removeObserver(this);
          reject(
            new Error(
              `SubscribeAndReceiveSubscribeAckTask got canceled while waiting for SdkSubscribeAckFrame`
            )
          );
        }

        handleSignalingClientEvent(event: SignalingClientEvent): void {
          if (event.isConnectionTerminated()) {
            const message = `SubscribeAndReceiveSubscribeAckTask connection was terminated with code ${event.closeCode} and reason: ${event.closeReason}`;
            context.logger.warn(message);

            let statusCode: MeetingSessionStatusCode = MeetingSessionStatusCode.TaskFailed;
            if (event.closeCode >= 4500 && event.closeCode < 4600) {
              statusCode = MeetingSessionStatusCode.SignalingInternalServerError;
            }
            context.audioVideoController.handleMeetingSessionStatus(
              new MeetingSessionStatus(statusCode),
              new Error(message)
            );
            return;
          }

          if (
            event.type !== SignalingClientEventType.ReceivedSignalFrame ||
            event.message.type !== SdkSignalFrame.Type.SUBSCRIBE_ACK
          ) {
            return;
          }

          this.signalingClient.removeObserver(this);

          // @ts-ignore: force cast to SdkSubscribeAckFrame
          const subackFrame: SdkSubscribeAckFrame = event.message.suback;
          resolve(subackFrame);
        }
      }

      const interceptor = new Interceptor(this.context.signalingClient);
      this.context.signalingClient.registerObserver(interceptor);
      this.taskCanceler = interceptor;
    });
  }
}
