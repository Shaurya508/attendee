// Holds the state of a bot video output stream. We need this class because there are two bot video output streams, one for webcam and one for screenshare.
class BotVideoOutputStream {
    constructor({
        turnOnInput = () => {},
        turnOffInput = () => {},
        ensureMicOn = () => {},
        ensureMicOff = () => {},
        getGainNode = () => {},
        getAudioContext = () => {},
        createSourceAudioTrack = () => {},
    }) {
        this.turnOnInput = turnOnInput;
        this.turnOffInput = turnOffInput;
        this.ensureMicOn = ensureMicOn;
        this.ensureMicOff = ensureMicOff;
        this.getGainNode = getGainNode;
        this.getAudioContext = getAudioContext;
        this.createSourceAudioTrack = createSourceAudioTrack;

        // --- VIDEO SOURCE SETUP (single source canvas) ---
        this.canvas = document.createElement("canvas");
        // Canvas must be 1280x640. Needed to work in Teams.
        this.canvasWidthForImage = 1280;
        this.canvasHeightForImage = 640;
        this.canvas.width = this.canvasWidthForImage;
        this.canvas.height = this.canvasHeightForImage;
        this.canvasCtx = this.canvas.getContext("2d");
        this.imageRedrawInterval = null;
        this.imageToDraw = null;
        this.imageDrawParams = null;

        this.canvasCtx.fillStyle = "black";
        this.canvasCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        const sourceVideoStream = this.canvas.captureStream(30); // NEEDS to be 30 or Google Meet complains

        // This is our *source* video track; we will CLONE it for callers.
        const videoTracks = sourceVideoStream.getVideoTracks();
        this.sourceVideoTrack = videoTracks[0] || null;

        this.videoElement = null;
        this.videoRafId = null;
        this.videoAudioSource = null;
    }

    /**
     * Display a PNG image on the virtual webcam.
     *
     * @param {ArrayBuffer|Uint8Array} imageBytes - Raw PNG bytes.
     * @returns {Promise<void>}
     */
    // 3 non-obvious things you need to do to make this work:
    // 1. Image needs to be redrawn on canvas
    // 2. Canvas needs to have a fixed "reasonable" size
    async displayImage(imageBytes) {
        this._stopVideoPlayback(); // Ensure no video is currently drawing

        if (!imageBytes) {
            throw new Error("displayImage: imageBytes is required.");
        }

        let buffer;
        if (imageBytes instanceof ArrayBuffer) {
            buffer = imageBytes;
        } else if (ArrayBuffer.isView(imageBytes)) {
            buffer = imageBytes.buffer;
        } else {
            throw new Error(
                "displayImage: expected ArrayBuffer or TypedArray for imageBytes."
            );
        }

        const blob = new Blob([buffer], { type: this._detectImageType(buffer) });
        const url = URL.createObjectURL(blob);
        try {
            this.imageToDraw = await this._loadImage(url);
            this.canvas.width = this.canvasWidthForImage;
            this.canvas.height = this.canvasHeightForImage;
            this.imageDrawParams = this.calculateImageDrawParamsForLetterBoxing(this.imageToDraw.width, this.imageToDraw.height);
            this.canvasCtx.drawImage(this.imageToDraw, this.imageDrawParams.offsetX, this.imageDrawParams.offsetY, this.imageDrawParams.width, this.imageDrawParams.height);
            // Set up an interval that redraws the image every 1000ms. Needed to work in Teams.
            if (!this.imageRedrawInterval) {
                this.imageRedrawInterval = setInterval(() => {
                    this.canvasCtx.drawImage(this.imageToDraw, this.imageDrawParams.offsetX, this.imageDrawParams.offsetY, this.imageDrawParams.width, this.imageDrawParams.height);
                }, 1000);
            }
            this.ensureInputOn();

            // Capture last image bytes, so that we can display it again if we play a video
            this.lastImageBytes = imageBytes;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    _loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = (err) => reject(err);
            img.src = url;
        });
    }

    _detectImageType(buffer) {
        const bytes = new Uint8Array(buffer);
        if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
            return "image/jpeg";
        }
        return "image/png";
    }

    ensureInputOn() {
        try {
            this.turnOnInput && this.turnOnInput();
        } catch (e) {
            console.error("Error in turnOnInput callback:", e);
        }
    }

    ensureInputOff() {
        try {
            this.turnOffInput && this.turnOffInput();
        } catch (e) {
            console.error("Error in turnOffInput callback:", e);
        }
    }

    isVideoPlaying() {
        return !!this.videoElement && !this.videoElement.paused && !this.videoElement.ended;
    }

    /**
     * Play a video (with audio) through the virtual webcam/mic.
     *
     * @param {string} videoUrl - URL of the video to play.
     * @param {boolean} loop - Whether to loop the video.
     * @returns {Promise<void>}
     */
    async playVideo(videoUrl, loop, muteVideo) {
        if (!videoUrl) {
            throw new Error("playVideo: videoUrl is required.");
        }

        this._stopVideoPlayback();
        this._stopImageRedrawInterval();

        if (!this.videoElement) {
            this.videoElement = document.createElement("video");
            this.videoElement.playsInline = true;
        }

        this.videoElement.muted = muteVideo;
        this.videoElement.src = videoUrl;
        this.videoElement.loop = loop;
        this.videoElement.autoplay = true;
        this.videoElement.crossOrigin = "anonymous";

        if (!this.videoAudioSource) {
            // Create a Web Audio source for the video element
            this.videoAudioSource =
                this.getAudioContext().createMediaElementSource(this.videoElement);
            this.videoAudioSource.connect(this.getGainNode());
            // (Optional) also connect to speakers:
            // this.videoAudioSource.connect(this.audioContext.destination);
        }

        if (this.getAudioContext().state === "suspended") {
            await this.getAudioContext().resume();
        }

        await this.videoElement.play();
        this.ensureInputOn();
        if (!muteVideo)
            this.ensureMicOn();

        this._startVideoDrawingLoop();

        // Add event listener for when video ends to display the last image
        this.videoEndedHandler = () => {
            // If we had an image, display it again keep the input on if not turn it off
            if (this.lastImageBytes) {
                this.displayImage(this.lastImageBytes);
            }
            else {
                this.ensureInputOff();
            }
        };
        this.videoElement.addEventListener('ended', this.videoEndedHandler);
    }



    /**
     * Play a video by fetching it first and using a blob URL.
     *
     * Useful for environments with restrictive CSP (e.g., Teams).
     *
     * @param {string} videoUrl - URL of the video to play.
     * @param {boolean} loop - Whether to loop the video.
     * @returns {Promise<void>}
     */
    async playVideoWithBlobUrl(videoUrl, loop, muteVideo) {
        if (!videoUrl) {
            throw new Error("playVideoWithBlobUrl: videoUrl is required.");
        }

        this._stopVideoPlayback();
        this._stopImageRedrawInterval();

        if (!this.videoElement) {
            this.videoElement = document.createElement("video");
            this.videoElement.playsInline = true;
        }

        // Fetch video and create a blob URL to avoid CSP violations.
        let videoBlobUrl = null;
        try {
            const response = await fetch(videoUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
            }

            const contentLength = response.headers.get("content-length");
            if (contentLength) {
                const sizeMB = parseInt(contentLength, 10) / 1024 / 1024;
                if (sizeMB > 100) {
                    console.warn(
                        `Large video detected (${Math.round(sizeMB * 100) / 100} MB). ` +
                        "This will be loaded entirely into memory."
                    );
                    window.ws.sendJson({
                        type: 'LargeVideoDetectedWarning',
                        message: `In playVideoWithBlobUrl large video detected (${Math.round(sizeMB * 100) / 100} MB). This will be loaded entirely into memory.`
                    });
                }
            }

            const blob = await response.blob();
            videoBlobUrl = URL.createObjectURL(blob);
        } catch (fetchError) {
            throw new Error(`Failed to fetch video for playback: ${fetchError.message}`);
        }

        this.videoBlobUrl = videoBlobUrl;

        this.videoElement.muted = muteVideo;
        this.videoElement.src = videoBlobUrl;
        this.videoElement.loop = loop;
        this.videoElement.autoplay = true;
        this.videoElement.crossOrigin = "anonymous";

        if (!this.videoAudioSource) {
            // Create a Web Audio source for the video element
            this.videoAudioSource =
                this.getAudioContext().createMediaElementSource(this.videoElement);
            this.videoAudioSource.connect(this.getGainNode());
            // (Optional) also connect to speakers:
            // this.videoAudioSource.connect(this.audioContext.destination);
        }

        if (this.getAudioContext().state === "suspended") {
            await this.getAudioContext().resume();
        }

        await this.videoElement.play();
        this.ensureInputOn();
        if (!muteVideo)
            this.ensureMicOn();

        this._startVideoDrawingLoop();

        // Add event listener for when video ends to display the last image
        this.videoEndedHandler = () => {
            // If we had an image, display it again keep the input on if not turn it off
            if (this.lastImageBytes) {
                this.displayImage(this.lastImageBytes);
            }
            else {
                this.ensureInputOff();
            }
            if (this.videoBlobUrl) {
                URL.revokeObjectURL(this.videoBlobUrl);
                this.videoBlobUrl = null;
            }
        };
        this.videoElement.addEventListener("ended", this.videoEndedHandler);
    }



    _startVideoDrawingLoop() {
        if (!this.videoElement) return;

        let lastDrawTime = 0;
        // emmy: was 1000 / 15 — on a busy Meet page the rAF ticks made that ~12-13 fps (measured
        // 2026-09-15: 25 fps in from the streamer, 13 fps out to Meet), too few for a live
        // avatar's lips. 30 matches captureStream(30); the 4 ms slack lets a 60 Hz rAF draw every
        // second tick instead of skipping to the third.
        const drawInterval = 1000 / 30 - 4;

        // emmy: on the virtual display Chrome can decide this window is occluded and stop
        // compositing it, at which point canvas.captureStream quietly stops producing frames:
        // the rAF timer keeps ticking (redrawFps 30) while the track emits 5 (source.fps 5),
        // with Meet reporting limit 'none' because nothing is limiting Meet. The four
        // --disable-*-occluded / backgrounding flags on the bot's Chrome reduced that but did
        // not end it. requestFrame() pushes a frame explicitly, so production follows OUR draw
        // loop instead of Chrome's compositing decisions. captureStream(30) stays as it is —
        // upstream warns Meet complains otherwise — and requestFrame works alongside a fixed
        // rate, simply forcing the capture the compositor would have skipped.
        let pushFrames = !!(this.sourceVideoTrack && typeof this.sourceVideoTrack.requestFrame === 'function');

        const drawFrame = (timestamp) => {
            if (
                !this.videoElement ||
                this.videoElement.paused ||
                this.videoElement.ended
            ) {
                this.videoRafId = null;
                return;
            }

            // Only draw if enough time has passed (throttle to 1/3 of normal rate)
            if (timestamp - lastDrawTime >= drawInterval) {
                // Resize canvas on first valid frame
                const vw = this.videoElement.videoWidth;
                const vh = this.videoElement.videoHeight;
                if (vw && vh && (this.canvas.width !== vw || this.canvas.height !== vh)) {
                    this.canvas.width = vw;
                    this.canvas.height = vh;
                }

                this.canvasCtx.drawImage(
                    this.videoElement,
                    0,
                    0,
                    this.canvas.width,
                    this.canvas.height
                );

                lastDrawTime = timestamp;
                this.emmyDraws = (this.emmyDraws || 0) + 1;   // emmy: redraw-rate diagnostic

                if (pushFrames) {
                    try {
                        this.sourceVideoTrack.requestFrame();
                    } catch (e) {
                        // one failure is enough — never throw 30 times a second
                        pushFrames = false;
                        console.warn('emmy: canvas requestFrame failed, leaving capture automatic:', e);
                    }
                }
            }

            this.videoRafId = requestAnimationFrame(drawFrame);
        };

        this.videoRafId = requestAnimationFrame(drawFrame);
    }

    _stopVideoPlayback() {
        if (this.videoRafId != null) {
            cancelAnimationFrame(this.videoRafId);
            this.videoRafId = null;
        }
        if (this.videoBlobUrl) {
            URL.revokeObjectURL(this.videoBlobUrl);
            this.videoBlobUrl = null;
        }
        if (this.videoElement) {
            this.videoElement.pause();
            // Remove the ended event listener if it exists
            if (this.videoEndedHandler) {
                this.videoElement.removeEventListener('ended', this.videoEndedHandler);
                this.videoEndedHandler = null;
            }
            // Keep src in case you want to resume later; or clear it:
            // this.videoElement.src = "";
        }
    }

    _stopImageRedrawInterval() {
        if (this.imageRedrawInterval) {
            clearInterval(this.imageRedrawInterval);
            this.imageRedrawInterval = null;
        }
    }



    calculateImageDrawParamsForLetterBoxing(imageWidth, imageHeight) {
        const imgAspect = imageWidth / imageHeight;
        const canvasAspect = this.canvas.width / this.canvas.height;
        
        // Calculate dimensions to fit image within canvas with letterboxing
        let renderWidth, renderHeight, offsetX, offsetY;
        
        if (imgAspect > canvasAspect) {
            // Image is wider than canvas (horizontal letterboxing)
            renderWidth = this.canvas.width;
            renderHeight = this.canvas.width / imgAspect;
            offsetX = 0;
            offsetY = (this.canvas.height - renderHeight) / 2;
        } else {
            // Image is taller than canvas (vertical letterboxing)
            renderHeight = this.canvas.height;
            renderWidth = this.canvas.height * imgAspect;
            offsetX = (this.canvas.width - renderWidth) / 2;
            offsetY = 0;
        }
        
        return {
            offsetX: offsetX,
            offsetY: offsetY,
            width: renderWidth,
            height: renderHeight
        };
    }



    /**
     * Play a MediaStream (e.g. from a WebRTC peer connection) through the
     * virtual webcam and mic.
     *
     * - Video tracks are drawn onto the canvas (same path as playVideo).
     * - Audio tracks, if present, are routed into the same gainNode /
     *   virtual mic pipeline as playPCMAudio / playVideo.
     *
     * @param {MediaStream} mediaStream
     * @returns {Promise<void>}
     */
    async playMediaStream(mediaStream) {
        if (!(mediaStream instanceof MediaStream)) {
            throw new Error("playMediaStream: mediaStream must be a MediaStream.");
        }
        try{

            // Stop any previous video playback and image redraw loop
            this._stopVideoPlayback();
            this._stopImageRedrawInterval();

            if (!this.videoElement) {
                this.videoElement = document.createElement("video");
                this.videoElement.playsInline = true;
            }

            this.videoElement.muted = true;
            // Attach the MediaStream to the video element
            this.videoElement.srcObject = mediaStream;
            this.videoElement.loop = false;
            this.videoElement.autoplay = true;

            ///---- NOT SURE IF WE NEED THIS
            this.createSourceAudioTrack();

            // (Re)wire a MediaStreamAudioSourceNode from the stream into the same gainNode
            if (this.mediaStreamAudioSource) {
                this.mediaStreamAudioSource.disconnect();
            }
            this.mediaStreamAudioSource =
                this.getAudioContext().createMediaStreamSource(mediaStream);
            this.mediaStreamAudioSource.connect(this.getGainNode());
            ///----

            if (this.getAudioContext().state === "suspended") {
                await this.getAudioContext().resume();
            }

            await this.videoElement.play();
            this.ensureInputOn();
            this.ensureMicOn();

            this._startVideoDrawingLoop();
        }
        catch (e) {
            window.ws.sendJson({
                type: 'PLAY_MEDIA_STREAM_ERROR',
                error: e.message
            });
        }
    }

    async stopMediaStream() {
        this._stopVideoPlayback();
        
        // If we had an image, display it again keep the input on if not turn it off
        if (this.lastImageBytes) {
            this.displayImage(this.lastImageBytes);
        }
        else {
            this.ensureInputOff();
        }
    }
}

class BotOutputManager {
    /**
     * @param {Object} callbacks
     * @param {Function} [callbacks.turnOnWebcam]
     * @param {Function} [callbacks.turnOffWebcam]
     * @param {Function} [callbacks.turnOnMic]
     * @param {Function} [callbacks.turnOffMic]
     * @param {boolean} [callOriginalGetUserMedia=false]
     */
    constructor({
        turnOnWebcam = () => {},
        turnOffWebcam = () => {},
        turnOnScreenshare = () => {},
        turnOffScreenshare = () => {},
        turnOnMic = () => {},
        turnOffMic = () => {},
        callOriginalGetUserMedia = false,
    } = {}) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("navigator.mediaDevices.getUserMedia is not available in this context.");
        }

        this.turnOnWebcam = turnOnWebcam;
        this.turnOffWebcam = turnOffWebcam;
        this.turnOnScreenshare = turnOnScreenshare;
        this.turnOffScreenshare = turnOffScreenshare;
        this.turnOnMic = turnOnMic;
        this.turnOffMic = turnOffMic;
        this.callOriginalGetUserMedia = callOriginalGetUserMedia;
        
        // We don't create the sourceAudioTrack until we need it. Otherwise it will play through the speakers. Not sure why this happens.
        this.sourceAudioTrack = null;

        // ---- AUDIO QUEUE STATE ----
        this.audioQueue = [];
        this.isPlayingAudioQueue = false;
        this.nextPlayTime = 0;
        this.sampleRate = 44100;
        this.numChannels = 1;
        this.turnOffMicTimeout = null;

        this._originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
            navigator.mediaDevices
        );

        // --- BOT OUTPUT PEER CONNECTION SETUP ---
        this.botOutputPeerConnection = null;
        this.botOutputMediaStream = null;
        this.botOutputMediaStreamOutputDestination = null;
        this.botOutputMediaStreamIsReadyInterval = null;

        // Webcam video output stream
        this.webcamVideoOutputStream = new BotVideoOutputStream({
            turnOnInput: this.turnOnWebcam,
            turnOffInput: this.turnOffWebcam,
            ensureMicOn: () => this.ensureMicOn(),
            ensureMicOff: () => this.ensureMicOff(),
            getGainNode: () => this.gainNode,
            getAudioContext: () => this.audioContext,
            createSourceAudioTrack: () => this._createSourceAudioTrack(),
        });

        this.screenShareVideoOutputStream = new BotVideoOutputStream({
            turnOnInput: this.turnOnScreenshare,
            turnOffInput: this.turnOffScreenshare,
            ensureMicOn: () => this.ensureMicOn(),
            ensureMicOff: () => this.ensureMicOff(),
            getGainNode: () => this.gainNode,
            getAudioContext: () => this.audioContext,
            createSourceAudioTrack: () => this._createSourceAudioTrack(),
        });

        this._installGetUserMediaInterceptor();
        this._installGetDisplayMediaInterceptor();
    }

    _createSourceAudioTrack() {
        if (this.sourceAudioTrack) {
            return;
        }

        // --- AUDIO SOURCE SETUP (single source) ---
        this.audioContext = new AudioContext();
        this.gainNode = this.audioContext.createGain();
        this.audioDestination = this.audioContext.createMediaStreamDestination();

        this.gainNode.gain.value = 1.0;

        this.gainNode.connect(this.audioDestination);
        this.gainNode.connect(this.audioContext.destination); // This causes it to play through the speakers

        // This is our *source* audio track; we will CLONE it for callers.
        const audioTracks = this.audioDestination.stream.getAudioTracks();
        this.sourceAudioTrack = audioTracks[0] || null;
    }

    _installGetUserMediaInterceptor() {
        const self = this;

        navigator.mediaDevices.getUserMedia = async function interceptedGetUserMedia(
            constraints
        ) {
            const needAudio =
                !!(constraints && constraints.audio !== false && constraints.audio != null);
            const needVideo =
                !!(constraints && constraints.video !== false && constraints.video != null);

            // Edge-case: if nothing is requested, just delegate.
            if (!needAudio && !needVideo) {
                return self._originalGetUserMedia(constraints);
            }

            let originalStream;
            if (self.callOriginalGetUserMedia) {
                try {
                    // Call the *original* getUserMedia to trigger permissions, etc.
                    originalStream = await self._originalGetUserMedia(constraints);
                } catch (err) {
                    console.error("Error from original getUserMedia:", err);
                    throw err; // propagate the same error to the caller
                }

                // If for some reason we didn't get a stream, just bail out.
                if (!originalStream || typeof originalStream.getTracks !== "function") {
                    return originalStream;
                }

                // Stop any real tracks so we’re not actually using the real devices.
                originalStream.getTracks().forEach(t => t.stop());
            }

            // Build the virtual stream we want to expose to the app.
            const stream = new MediaStream();

            if (needVideo && self.webcamVideoOutputStream.sourceVideoTrack) {
                // Clone from the source so app-level stop() doesn't kill our source. Otherwise this won't work in Teams.
                const videoClone = self.webcamVideoOutputStream.sourceVideoTrack.clone();
                stream.addTrack(videoClone);
            }

            if (needAudio) {
                // You need to initialize the source audio track here. It will play through the speakers if you initialize it in the constructor.
                self._createSourceAudioTrack();
                const audioClone = self.sourceAudioTrack.clone();
                stream.addTrack(audioClone);
            }

            return stream;
        };
    }

    _installGetDisplayMediaInterceptor() {
        const self = this;

        navigator.mediaDevices.getDisplayMedia = async function interceptedGetDisplayMedia(
            constraints
        ) {
            const needVideo =
                !!(constraints && constraints.video !== false && constraints.video != null);

            // Edge-case: if nothing is requested, just delegate.
            if (!needVideo) {
                return self._originalGetDisplayMedia(constraints);
            }

            const stream = new MediaStream();

            if (needVideo && self.screenShareVideoOutputStream.sourceVideoTrack) {
                // Clone from the source so app-level stop() doesn't kill our source. Otherwise this won't work in Teams.
                const videoClone = self.screenShareVideoOutputStream.sourceVideoTrack.clone();
                // emmy: a screenshare is encoded as "detail" (sharp text, frame rate dropped —
                // Meet delivered a voice agent's page at 5 fps, measured 2026-09-15). The page
                // carries a live avatar, so mark it motion and ignore later attempts to reset it.
                videoClone.contentHint = "motion";
                try {
                    Object.defineProperty(videoClone, "contentHint", {
                        get: () => "motion", set: () => {}, configurable: true });
                } catch (e) {
                    console.warn("could not pin contentHint=motion:", e);
                }
                // emmy: this is what caused the 5 fps screenshare, and it is NOT what it looks
                // like. Meet calls applyConstraints({frameRate:{min:30,ideal:30}}) on this track
                // at join — it is ASKING FOR 30, not throttling. But allowing that call collapses
                // actual delivery to exactly 5.000 (25 frames per 5 s, dead stable, sample after
                // sample) while the page is visible, our draw loop runs at 30, requestFrame pushes
                // every frame, and Meet reports limit 'none'. Refusing the call holds delivery at
                // 30. Toggling this one guard is the whole difference; nothing else changed.
                //
                // So the constraint is not a policy we are overriding, it is a landmine: applying
                // ANY frameRate constraint to a canvas-capture track installs Chrome's frame-rate
                // adapter, and on this kind of source that adapter settles far below the rate
                // requested. Verified in Chrome 152 that {min:30,ideal:30} is accepted and leaves
                // getSettings().frameRate reading 30 — so the damage is to DELIVERY, not to the
                // reported setting, which is why it went unseen for so long and why every fix
                // aimed at the encoder (maxFramerate, maxBitrate, the occlusion flags) missed it.
                //
                // Strip frameRate, pass everything else through untouched (width still applies).
                const applyConstraintsOriginal = videoClone.applyConstraints.bind(videoClone);
                videoClone.applyConstraints = function (constraints) {
                    const next = Object.assign({}, constraints || {});
                    if (next.frameRate != null) {
                        try {
                            window.ws && window.ws.sendJson && window.ws.sendJson({
                                type: 'EMMY_VIDEO_FPS', hop: 'constraint-refused',
                                frameRate: JSON.stringify(next.frameRate),
                            });
                        } catch (e) { /* a diagnostic must never break the call it reports on */ }
                        delete next.frameRate;
                    }
                    return applyConstraintsOriginal(next);
                };
                stream.addTrack(videoClone);
            }

            return stream;
        };
    }

    ensureMicOn() {
        try {
            this.turnOnMic && this.turnOnMic();
        } catch (e) {
            console.error("Error in turnOnMic callback:", e);
        }
    }

    disableMic() {
        try {
            this.turnOffMic && this.turnOffMic();
        } catch (e) {
            console.error("Error in turnOffMic callback:", e);
        }
    }

    async displayImage(imageBytes) {
        return this.webcamVideoOutputStream.displayImage(imageBytes);
    }

    isVideoPlaying() {
        return this.webcamVideoOutputStream.isVideoPlaying();
    }

    async playVideo(videoUrl, loop, muteVideo) {
        return this.webcamVideoOutputStream.playVideo(videoUrl, loop, muteVideo);
    }

    async playVideoWithBlobUrl(videoUrl, loop, muteVideo) {
        return this.webcamVideoOutputStream.playVideoWithBlobUrl(videoUrl, loop, muteVideo);
    }

    /**
     * Play raw PCM audio data through the virtual microphone.
     *
     * This version immediately enqueues chunks and lets a queue processor
     * build/schedule AudioBuffers, avoiding per-call scheduling jitter.
     *
     * @param {Int16Array|Float32Array|Array<number>|TypedArray} pcmData
     * @param {number} [sampleRate=44100]
     * @param {number} [numChannels=1]
     */
    async playPCMAudio(pcmData, sampleRate = 44100, numChannels = 1) {
        this._createSourceAudioTrack();
        this.ensureMicOn();

        // Update properties if they've changed
        if (this.sampleRate !== sampleRate || this.numChannels !== numChannels) {
            this.sampleRate = sampleRate;
            this.numChannels = numChannels;
        }

        // Convert Int16 PCM data to Float32 with proper scaling
        let audioData;
        if (pcmData instanceof Float32Array) {
            audioData = pcmData;
        } else {
            // Create a Float32Array of the same length
            audioData = new Float32Array(pcmData.length);
            // Scale Int16 values (-32768 to 32767) to Float32 range (-1.0 to 1.0)
            for (let i = 0; i < pcmData.length; i++) {
                // Division by 32768.0 scales the range correctly
                audioData[i] = pcmData[i] / 32768.0;
            }
        }

        const duration = audioData.length / (numChannels * sampleRate);

        this.audioQueue.push({
            data: audioData,
            duration,
        });

        // If we had a pending mic-off timer, cancel it – new audio is coming
        if (this.turnOffMicTimeout) {
            clearTimeout(this.turnOffMicTimeout);
            this.turnOffMicTimeout = null;
        }

        // Start processing if not already in progress
        if (!this.isPlayingAudioQueue) {
            this._processAudioQueue();
        }
    }

    _processAudioQueue() {
        if (this.audioQueue.length === 0) {
            this.isPlayingAudioQueue = false;
    
            // Delay turning off the mic by 2 seconds, only if queue stays empty
            if (this.turnOffMicTimeout) {
                clearTimeout(this.turnOffMicTimeout);
            }
            this.turnOffMicTimeout = setTimeout(() => {
                if (this.audioQueue.length === 0) {
                    this.disableMic();
                }
            }, 2000);
    
            return;
        }
    
        this.isPlayingAudioQueue = true;
    
        const currentTime = this.audioContext.currentTime;
        if (!this.nextPlayTime || this.nextPlayTime < currentTime) {
            // Catch up if we've fallen behind
            this.nextPlayTime = currentTime;
        }
    
        const { data, duration } = this.audioQueue.shift();
    
        const frames = data.length / this.numChannels;
        const audioBuffer = this.audioContext.createBuffer(
            this.numChannels,
            frames,
            this.sampleRate
        );
    
        if (this.numChannels === 1) {
            const channelData = audioBuffer.getChannelData(0);
            channelData.set(data);
        } else {
            for (let ch = 0; ch < this.numChannels; ch++) {
                const channelData = audioBuffer.getChannelData(ch);
                for (let i = 0; i < frames; i++) {
                    channelData[i] = data[i * this.numChannels + ch];
                }
            }
        }
    
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.gainNode); // -> gain node -> mic track
    
        source.start(this.nextPlayTime);
        this.nextPlayTime += duration;
    
        // Schedule the next queue processing a bit before the scheduled end
        const timeUntilNextProcessMs =
            (this.nextPlayTime - currentTime) * 1000 * 0.8;
    
        setTimeout(
            () => this._processAudioQueue(),
            Math.max(0, timeUntilNextProcessMs)
        );
    }

    getAudioContextDestination() {
        return this.audioContext?.destination;
    }

    botOutputMediaStreamIsReady() {
        return this.botOutputMediaStream.getVideoTracks().length > 0 && this.botOutputMediaStream.getAudioTracks().length > 0;
    }

    async playBotOutputMediaStream(outputDestination) {
        this.botOutputMediaStreamOutputDestination = outputDestination;

        if (!this.botOutputMediaStreamIsReady()) {
            // Add interval to check if the bot output media stream is ready
            
            if (!this.botOutputMediaStreamIsReadyInterval)
                this.botOutputMediaStreamIsReadyInterval = setInterval(() => {
                    if (this.botOutputMediaStreamIsReady()) {
                        this.playBotOutputMediaStream(this.botOutputMediaStreamOutputDestination);
                    }
                }, 1000);
            return;
        }

        if (this.botOutputMediaStreamIsReadyInterval)
            clearInterval(this.botOutputMediaStreamIsReadyInterval);

        if (outputDestination === "screenshare") {
            return this.screenShareVideoOutputStream.playMediaStream(this.botOutputMediaStream);
        } else {
            return this.webcamVideoOutputStream.playMediaStream(this.botOutputMediaStream);
        }
    }

    async stopBotOutputMediaStream() {
        if (this.botOutputMediaStreamOutputDestination === "screenshare") {
            return this.screenShareVideoOutputStream.stopMediaStream();
        } else {
            return this.webcamVideoOutputStream.stopMediaStream();
        }
    }

    isReadyForWebpageStreamer() {
        return !!window.styleManager.getMeetingAudioStream();
    }

    async getBotOutputPeerConnectionOffer() {
        try
        {
            // 2) Create the RTCPeerConnection
            this.botOutputPeerConnection = new RTCPeerConnection();
        
            // 3) Receive the server's *video* and *audio*
            this.botOutputMediaStream = new MediaStream();
            this.botOutputPeerConnection.ontrack = (ev) => {
                this.botOutputMediaStream.addTrack(ev.track);
            };
        
            // We still want to receive the server's video
            this.botOutputPeerConnection.addTransceiver('video', { direction: 'recvonly' });
        
            // ❗ Instead of recvonly audio, we now **send** our mic upstream:
            const meetingAudioStream = window.styleManager.getMeetingAudioStream();
            for (const track of meetingAudioStream.getAudioTracks()) {
                this.botOutputPeerConnection.addTrack(track, meetingAudioStream);
            }
        
            // Create/POST offer → set remote answer
            const offer = await this.botOutputPeerConnection.createOffer();
            await this.botOutputPeerConnection.setLocalDescription(offer);
            return { sdp: this.botOutputPeerConnection.localDescription.sdp, type: this.botOutputPeerConnection.localDescription.type };
        }
        catch (e) {
            return { error: e.message };
        }
    }

    async startBotOutputPeerConnection(offerResponse) {
        await this.botOutputPeerConnection.setRemoteDescription(offerResponse);
        
        // Start latency measurement for the bot output peer connection
        this.startLatencyMeter(this.botOutputPeerConnection, "bot-output");
        this.startEmmyFpsMeter(this.botOutputPeerConnection);
    }

    // emmy diagnostic: the frame rate the bot actually RECEIVES from the webpage streamer
    // (before Meet's encoder). Paired with [meet-out] from the Meet payload, it shows which
    // hop drops frames. Logged by the bot's websocket handler as "Received JSON message".
    startEmmyFpsMeter(pc) {
        // emmy: kbps and codec on THIS hop. The streamer encodes with aiortc, whose software
        // VP8/H264 encoders are bitrate-capped by Python constants (VP8 tops out at 1.5 Mbps).
        // Meet re-encodes whatever arrives at ~4 Mbps, which cannot restore detail this hop
        // threw away — so a flat ceiling here is the sharpness limit of the whole chain, and
        // no amount of tuning meet-out will move it. A reading that sits pinned at one number
        // is the cap; one that varies with the picture is the encoder choosing.
        let lastBytes = 0;
        let lastAt = 0;
        setInterval(async () => {
            try {
                const stats = await pc.getStats();
                // how many frames/s the bot actually drew onto the canvas Meet encodes from
                const out = this.botOutputMediaStreamOutputDestination === 'screenshare'
                    ? this.screenShareVideoOutputStream : this.webcamVideoOutputStream;
                const redrawFps = out ? (out.emmyDraws || 0) / 5 : -1;
                if (out) out.emmyDraws = 0;
                stats.forEach(r => {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') {
                        const at = r.timestamp || Date.now();
                        const bytes = r.bytesReceived || 0;
                        // bytes * 8 / milliseconds is already kilobits per second
                        const kbps = (lastAt && at > lastAt)
                            ? Math.round(((bytes - lastBytes) * 8) / (at - lastAt)) : 0;
                        lastBytes = bytes;
                        lastAt = at;
                        const codec = stats.get(r.codecId);
                        window.ws.sendJson({
                            type: 'EMMY_VIDEO_FPS',
                            hop: 'streamer-in',
                            redrawFps: redrawFps,
                            fps: r.framesPerSecond || 0,
                            width: r.frameWidth || 0,
                            height: r.frameHeight || 0,
                            framesDropped: r.framesDropped || 0,
                            packetsLost: r.packetsLost || 0,
                            kbps: kbps,
                            codec: codec ? codec.mimeType : '',
                            // emmy: the smoking gun for canvas starvation. Occlusion and
                            // backgrounding both mark the page hidden; if source.fps collapses
                            // while this reads 'visible', the cause is something else.
                            vis: document.visibilityState,
                        });
                    }
                });
            } catch (e) {
                console.warn('emmy fps meter (streamer-in) failed:', e);
            }
        }, 5000);
    }

    startLatencyMeter(pc, label="rx") {
        setInterval(async () => {
            const stats = await pc.getStats();
            let rtt_ms = 0, jb_a_ms = 0, jb_v_ms = 0, dec_v_ms = 0;

            stats.forEach(r => {
                if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
                    rtt_ms = (r.currentRoundTripTime || 0) * 1000;
                }
                if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                    const d = (r.jitterBufferDelay || 0);
                    const n = (r.jitterBufferEmittedCount || 1);
                    jb_a_ms = (d / n) * 1000;
                }
                if (r.type === 'inbound-rtp' && r.kind === 'video') {
                    const d = (r.jitterBufferDelay || 0);
                    const n = (r.jitterBufferEmittedCount || 1);
                    jb_v_ms = (d / n) * 1000;
                    dec_v_ms = ((r.totalDecodeTime || 0) / (r.framesDecoded || 1)) * 1000;
                }
            });

            const est_audio_owd = (rtt_ms / 2) + jb_a_ms;
            const est_video_owd = (rtt_ms / 2) + jb_v_ms + dec_v_ms;

            const logStatement = `[${label}] est one-way: audio≈${est_audio_owd|0}ms, video≈${est_video_owd|0}ms  (rtt=${rtt_ms|0}, jb_a=${jb_a_ms|0}, jb_v=${jb_v_ms|0}, dec_v=${dec_v_ms|0})`;
            console.log(logStatement);
            window.ws.sendJson({
                type: 'BOT_OUTPUT_PEER_CONNECTION_STATS',
                logStatement: logStatement
            });
        }, 60000);
    }
}