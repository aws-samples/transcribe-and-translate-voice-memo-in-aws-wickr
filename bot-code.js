// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

const WickrIOAPI = require('wickrio_addon');
const WickrIOBotAPI = require('wickrio-bot-api');
const util = require('util')
const logger = require('wickrio-bot-api').logger
const { v4: uuidv4 } = require('uuid');
const { PutObjectCommand, GetObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const { ListTranscriptionJobsCommand, TranscribeClient, StartTranscriptionJobCommand } = require("@aws-sdk/client-transcribe");
const { ComprehendClient, DetectDominantLanguageCommand } = require('@aws-sdk/client-comprehend');
const { TranslateTextCommand, TranslateClient } = require('@aws-sdk/client-translate');

console.log = function () {
  logger.info(util.format.apply(null, arguments))
}
console.error = function () {
  logger.error(util.format.apply(null, arguments))
}

var fs = require('fs');

module.exports = WickrIOAPI;
process.stdin.resume(); // so the program will not close instantly
var bot;

let fileName = uuidv4();

async function exitHandler(options, err) {
  try {
    var closed = await bot.close();
    console.log(closed);
    if (err) {
      console.log("Exit Error:", err);
      process.exit();
    }
    if (options.exit) {
      process.exit();
    } else if (options.pid) {
      process.kill(process.pid);
    }
  } catch (err) {
    console.log(err);
  }
}

//catches ctrl+c and stop.sh events
process.on('SIGINT', exitHandler.bind(null, {
  exit: true
}));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, {
  pid: true
}));
process.on('SIGUSR2', exitHandler.bind(null, {
  pid: true
}));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {
  exit: true
}));

/////////////////////////////////////

// Respond to user's input.
async function createResponse(request, vGroupID) {
  // setup the clients
  bot.processesJsonToProcessEnv()
  var tokens = JSON.parse(process.env.tokens)
  const REGION = tokens.AWS_REGION.value
  const INPUTBUCKET = tokens.AWS_INPUT_BUCKET.value
  const OUTPUTBUCKET = tokens.AWS_OUTPUT_BUCKET.value
  const LANGUAGE1 = tokens.AWS_LANGUAGE1.value
  const LANGUAGE2 = tokens.AWS_LANGUAGE2.value

  const LANG1 = LANGUAGE1.slice(0, 2)
  const LANG2 = LANGUAGE2.slice(0, 2)

  console.log('entered createResponse');

// Upload a file to S3
async function uploadFile() {

  const s3 = new S3Client({ region: REGION });
  var uploadParams = {
    Bucket: INPUTBUCKET,
    Body: ''
  }

  var fileStream = fs.createReadStream(request);
  fileStream.on('error', function(err) {
    console.log('File Error', err);
  });
  uploadParams.Body = fileStream;
  uploadParams.Key = fileName;
  
  const s3Data = await s3.send(new PutObjectCommand(uploadParams, function (err, data) {
    if (err) {
      console.log("Error", err);
    } if (data) {
      console.log("Upload Success", s3Data.Location);
    }
  }));
}

  const transcribeJobName = uuidv4();

  const params = {
    TranscriptionJobName: transcribeJobName,
    IdentifyLanguage: true,
    LanguageOptions: [LANGUAGE1, LANGUAGE2],
    MediaFormat: "wav", 
    Media: {
      MediaFileUri: `s3://${INPUTBUCKET}/${fileName}`,
    },
    OutputBucketName: OUTPUTBUCKET
  };
  
  
  async function runTranscribeJob() {
    try {
      const transcribeClient = new TranscribeClient({ region: REGION });
      await transcribeClient.send(
        new StartTranscriptionJobCommand(params)
      );
      console.log("Transcription started...");
  
      while(true) {
        const data = await transcribeClient.send(new ListTranscriptionJobsCommand({JobNameContains: transcribeJobName}));
        resultStatus =  data.TranscriptionJobSummaries[0].TranscriptionJobStatus;
        if(resultStatus == "COMPLETED") {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('Command did not contain COMPLETED, running again...');
      }
      console.log('Command output contained COMPLETED, exiting loop');
      
      const client = new S3Client({});
      const command = new GetObjectCommand({
        Bucket: OUTPUTBUCKET,
        Key: `${transcribeJobName}.json`
      });

      const comprehendClient = new ComprehendClient({
        region: REGION,
      })

      const translateClient = new TranslateClient({
      region: REGION,
    });
  
      try {
        var response = await client.send(command);
        const str = await response.Body.transformToString();
        var response = JSON.parse(str);
        var messageOutput = response.results.transcripts[0].transcript;
        console.log("Message output is ", messageOutput)

        const comprehendParams = {
          Text: messageOutput,
        };
        const detectDomLanguage = await comprehendClient.send(new DetectDominantLanguageCommand(comprehendParams));
        const domLanguage = detectDomLanguage.Languages[0].LanguageCode
        console.log("Dominant language is ", domLanguage)

        if (domLanguage === LANG1) {
          var transToLanguage = LANG2;
          console.log("Translating to ", LANG2)
        } else if (domLanguage === LANG2) {
         var transToLanguage = LANG1
          console.log("Translating to ", LANG1)
        }

        const data = await translateClient.send(new TranslateTextCommand({
          SourceLanguageCode: domLanguage,
          TargetLanguageCode: transToLanguage,
          Text: messageOutput,
        }))
        const finalMessage = data.TranslatedText + "\n\n" + messageOutput
        //console.log("Success. Translated text sent to user is: ", data.TranslatedText);
        console.log("Final message is ", finalMessage)
        WickrIOAPI.cmdSendRoomMessage(vGroupID, finalMessage);
      } catch (err) {
        console.error(err);
      }
    } catch (err) {
      console.log("Error", err);
    }
  };

  function runAll() {
    try {
      uploadFile()
    } finally {
      runTranscribeJob()
    }
  }
  runAll() 
}


async function main() { // entry point
  logger.info('entering main')
  try {
    var status;
    if (process.argv[2] === undefined) {
      var bot_username = fs.readFileSync('client_bot_username.txt', 'utf-8');
      bot_username = bot_username.trim();
      bot = new WickrIOBotAPI.WickrIOBot();
      status = await bot.start(bot_username)
    } else {
      bot = new WickrIOBotAPI.WickrIOBot();
      status = await bot.start(process.argv[2])
    }
    if (!status) {
      exitHandler(null, {
        exit: true,
        reason: 'Client not able to start'
      });
    }

    await bot.startListening(listen); 
  } catch (err) {
    logger.error(err);
  }
}

async function listen(rMessage) {
  logger.info('entering listen')
  rMessage = JSON.parse(rMessage);
  var sender = rMessage.sender;
  var vGroupID = rMessage.vgroupid;
  var request = rMessage.file.localfilename;
  var userArr = [];
  userArr.push(sender);
  if (request.includes('voice memo') || request.includes('VoiceMemo') || request.includes('AUDIO')) {
    console.log('calling createResponse()')
    await createResponse(request, vGroupID)
  } else {
    console.log('Not a voice memo file, exiting...')
    WickrIOAPI.cmdSendRoomMessage(vGroupID, "Not a voice memo, please try again");
  }

}

main();