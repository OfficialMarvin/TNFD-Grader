const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const RECOMMENDATIONS_PDF_PATH = 'Recommendations_of_the_Taskforce_on_Nature-related_Financial_Disclosures_September_2023.pdf';

app.use(express.static(__dirname));

app.post('/evaluate', upload.single('pdfFile'), async (req, res) => {
  try {
    // Upload the recommendations PDF to OpenAI
    const recommendationsFileId = await uploadFileToOpenAI(RECOMMENDATIONS_PDF_PATH);

    // Upload the user's PDF to OpenAI
    const userFileId = await uploadFileToOpenAI(req.file.path);

    // Create a vector store with both files
    const vectorStoreId = await createVectorStore([recommendationsFileId, userFileId]);

    // Generate the evaluation using OpenAI's API
    const evaluation = await generateEvaluation(vectorStoreId);

    res.json({
      score: evaluation.score,
      explanation: evaluation.explanation,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send('An error occurred during evaluation.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Helper functions

async function uploadFileToOpenAI(filePath) {
  const formData = new FormData();
  formData.append('file', require('fs').createReadStream(filePath));
  formData.append('purpose', 'assistants');

  const response = await fetch('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  const data = await response.json();
  return data.id;
}

async function createVectorStore(fileIds) {
  const response = await fetch('https://api.openai.com/v1/vector_stores', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      name: 'TNFD Evaluation Store',
      file_ids: fileIds,
    }),
  });

  const data = await response.json();
  return data.id;
}

async function generateEvaluation(vectorStoreId) {
  const assistantResponse = await fetch('https://api.openai.com/v1/beta/assistants', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      name: 'TNFD Evaluator',
      instructions:
        'Strict evaluation based on the provided recommendations criteria. The evaluation should be rigorous, ensuring that the report avoids greenwashing (superficial or misleading claims about environmental efforts). Return only a number out of 100%, with no text, followed by a paragraph-format explanation summary.',
      model: 'gpt-4',
      tools: [{ type: 'file_search' }],
      tool_resources: {
        file_search: {
          vector_store_ids: [vectorStoreId],
        },
      },
    }),
  });

  const assistantData = await assistantResponse.json();
  const assistantId = assistantData.id;

  // Create a thread and run to get the evaluation
  const threadResponse = await fetch('https://api.openai.com/v1/beta/threads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: 'Please evaluate the uploaded TNFD report.',
        },
      ],
    }),
  });

  const threadData = await threadResponse.json();
  const threadId = threadData.id;

  // Run the assistant on the thread
  const runResponse = await fetch(`https://api.openai.com/v1/beta/threads/${threadId}/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      assistant_id: assistantId,
    }),
  });

  const runData = await runResponse.json();
  const content = runData.messages[0].content;

  // Extract the score and explanation from the assistant's response
  const [scoreLine, ...explanationLines] = content.split('\n');
  const score = scoreLine.replace('%', '').trim();
  const explanation = explanationLines.join('\n').trim();

  return { score, explanation };
}
