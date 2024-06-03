import crypto from 'hypercore-crypto'; // Cryptographic functions for generating the key in app
import b4a from 'b4a';                 // Module for buffer-to-string and vice-versa conversions
import { swarm } from './network.js';
import { decodeChunk, encodeChunk } from './video.js';
import {createObservableMap} from './utils.js';

let cameraOn = false;
let localVideoTrack;
let remoteUsers = createObservableMap();

// When there's a new connection, listen for new video streams, and add them to the UI
swarm.on('connection', (socket) => {
  const strKey = b4a.toString(socket.remotePublicKey, 'hex').substring(0, 6)
  // Check if stream exists for this peer
  if (!remoteUsers.has(strKey)) {
    const transformer = new TransformStream({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
      }
    });
    onPeerJoined(strKey, transformer)
    remoteUsers.set(strKey, transformer);
  }

  socket.on('data', (chunk) => {
    const transformer = remoteUsers.get(strKey);
    try {
      const writer = transformer.writable.getWriter();
      writer.write(chunk);
      writer.releaseLock();
    } catch (error) {
      console.error("Error getting writer for peer:", strKey, error);
      // Handle the error (e.g., remove peer or reconnect)
    }
  });

  swarm.on('close',(info)=> {
    console.log({info});
  })
});

// When there's updates to the swarm, update the peers count
swarm.on('update', () => {
  document.querySelector('#peers-count').textContent = swarm.connections.size;
});

document.querySelector('#create-chat-room').addEventListener('click', createChatRoom);
document.querySelector('#join-form').addEventListener('submit', joinChatRoom);

async function joinSwarm(topicBuffer) {
  document.querySelector('#setup').classList.add('hidden');
  document.querySelector('#loading').classList.remove('hidden');
  swarm.join(topicBuffer);

  document.querySelector('#chat-room-topic').innerText = b4a.toString(topicBuffer, 'hex');
  document.querySelector('#loading').classList.add('hidden');
  document.querySelector('#chat').classList.remove('hidden');
}


async function leaveSwarm(topicBuffer) {
  document.querySelector('#setup').classList.remove('hidden');
  document.querySelector('#loading').classList.remove('hidden');
  await swarm.leave(topicBuffer);
  await swarm.flush()
  document.querySelector('#chat-room-topic').innerText = '';
  document.querySelector('#loading').classList.add('hidden');
  document.querySelector('#chat').classList.add('hidden');
}

async function createChatRoom() {
  const chanelKeyByte = crypto.randomBytes(32);
  await joinSwarm(chanelKeyByte);
}

async function joinChatRoom(e) {
  e.preventDefault();
  const topicStr = document.querySelector('#join-chat-room-topic').value;
  const topicBuffer = b4a.from(topicStr, 'hex');
  await joinSwarm(topicBuffer);
}

async function leaveChatRoom(e) {
  e?.preventDefault();
  const topicStr = document.querySelector('#join-chat-room-topic').value;
  const topicBuffer = b4a.from(topicStr, 'hex');
  localVideoTrack.enabled = false;
  await leaveSwarm(topicBuffer);
}

document.querySelector('#leave-btn').addEventListener('click', leaveChatRoom);

const cameraButton = document.getElementById('camera-btn');
const videoStreamsContainer = document.getElementById('video-streams');

async function startLocalStream() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const [firstTrack] = stream.getVideoTracks();
  localVideoTrack = firstTrack;

  const mediaProcessor = new MediaStreamTrackProcessor({ track: localVideoTrack });
  const inputStream = mediaProcessor.readable;

  const mediaGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
  const outputStream = mediaGenerator.writable;

  const encoderTransformStream = new TransformStream({
    start(controller) {
      this.frameCounter = 0;
      this.encoder = new VideoEncoder({
        output: (chunk) => {
          const encoded = encodeChunk(chunk);
          // Send the message to all peers (that you are connected to)
          const peers = [...swarm.connections]
          for (const peer of peers) {
            peer.write(encoded)
          }
          controller.enqueue(encoded);
        },
        error: (error) => {
          console.error('VideoEncoder error:', error);
        }
      });

      this.encoder.configure({
        codec: 'vp8',
        width: localVideoTrack.getSettings().width,
        height: localVideoTrack.getSettings().height,
        bitrate: 1_000_000,
        framerate: 30
      });
    },
    async transform(frame) {
      if (this.encoder.encodeQueueSize > 2) {
        frame.close();
      } else {
        this.frameCounter++;
        const insertKeyFrame = this.frameCounter % 150 === 0;
        this.encoder.encode(frame, { keyFrame: insertKeyFrame });
        frame.close();
      }
    },
    flush() {
      this.encoder.flush();
    }
  });

  const decoderTransformStream = new TransformStream({
    start(controller) {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          controller.enqueue(frame);
        },
        error: (error) => console.error('VideoDecoder error:', error)
      });

      this.decoder.configure({ codec: 'vp8' });
    },
    async transform(chunk) {
      const decoded = decodeChunk(chunk);
      this.decoder.decode(decoded);
    }
  });

  inputStream
    .pipeThrough(encoderTransformStream)
    .pipeThrough(decoderTransformStream)
    .pipeTo(outputStream);

  const existingVideo = document.getElementById('local-video')

  if(existingVideo){
    existingVideo.srcObject = new MediaStream([mediaGenerator]);
  } else {
    const video =  document.createElement('video');
    video.id = 'local-video';
    video.classList.add('video-container');
    video.style.width = '100%';
    video.style.height = '100%';
    video.autoplay = true;
    video.srcObject = new MediaStream([mediaGenerator]);

    const videoContainer = document.createElement('div');
    videoContainer.classList.add('video-container');
    videoContainer.id = 'user-container-local';

    videoContainer.appendChild(video);
    videoStreamsContainer.appendChild(videoContainer);
  }


  cameraOn = true;
}

async function stopLocalStream() {
  if (localVideoTrack) {
    const existingVideo = document.getElementById('local-video')
    existingVideo.pause();
    existingVideo.currentTime = 0; // Reset the video to the beginning
    // Stop all tracks of the MediaStream
    localVideoTrack.enabled = false;
    // Clear the srcObject to fully "stop" the video
    existingVideo.srcObject = null;
    cameraOn = false;
  }
}

cameraButton.addEventListener('click', async () => {
  if (cameraOn) {
    await stopLocalStream();
    cameraButton.innerHTML = 'Camera On';
  } else {
    await startLocalStream();
    cameraButton.innerHTML = 'Camera Off';
  }
});



remoteUsers.onAdd((key, value) => {
  console.log(`New item added: ${key} => ${value}`);
  // onPeerJoined(key, value);
});

remoteUsers.onRemove((key) => {
  remoteUsers.delete(key)
  console.log(`Item deleted: ${key}`);
  const idToRemove = `user-container-${key}`;
  const elementToRemove = document.getElementById(idToRemove);
  elementToRemove.remove()
});

function onPeerJoined(key,inputTransform) {
  if (!remoteUsers.get(key)) {
    const decoderTransformStream = new TransformStream({
      start(controller) {
        this.decoder = new VideoDecoder({
          output: (frame) => {
              controller.enqueue(frame);
          },
          error: (error) => console.error('VideoDecoder error:', error)
        });

        this.decoder.configure({ codec: 'vp8' });
      },
      async transform(chunk, controller) {
        const decoded = decodeChunk(chunk);
        if (decoded instanceof EncodedVideoChunk) {
          console.log({decoded});
          this.decoder.decode(decoded);
        } else if (!controller.closed) {
          controller.enqueue(chunk);
        }
      }
    });
    const remoteInput = inputTransform.readable.pipeThrough(decoderTransformStream);
    const mediaGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
    const outputStream = mediaGenerator.writable;
    remoteInput.pipeTo(outputStream);

    const existingVideoElement = document.getElementById(`video-${key}`)
    if (existingVideoElement) {
      existingVideoElement.srcObject = new MediaStream([mediaGenerator]);
    } else {
      const remoteVideo = document.createElement('video');
      remoteVideo.id = `video-${key}`;
      remoteVideo.classList.add('video-container');
      remoteVideo.style.width = '100%';
      remoteVideo.style.height = '100%';
      remoteVideo.autoplay = true;

      remoteVideo.srcObject = new MediaStream([mediaGenerator]);

      const videoContainer = document.createElement('div');
      videoContainer.classList.add('video-container');
      videoContainer.id = `user-container-${key}`;
      videoContainer.appendChild(remoteVideo);
      videoStreamsContainer.appendChild(videoContainer);
    }

  }
}
