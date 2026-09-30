// File tree/content endpoints for a project's files, extracted from
// server/index.js. Mounted directly on the app (not under a router prefix)
// so the historical full paths (`/api/projects/:projectId/files`,
// `/files/content`) are unchanged.
//
// Create/rename/delete/upload were removed with the Files tab (#546), and the
// single-file read/save (`/file`) with the in-chat code editor. What remains is
// read-only, for chat @file mentions and inline chat images.
import fs, { promises as fsPromises } from 'fs';

import express from 'express';
import mime from 'mime-types';

import { validateProjectPath } from '@/shared/utils.js';
import { getFileTree } from '@/shared/file-tree.js';

import { authenticateToken } from '../middleware/auth.js';
import { projectsDb } from '../modules/database/index.js';

const router = express.Router();

// Serve raw file bytes for previews and downloads.
router.get('/api/projects/:projectId/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const validation = await validateProjectPath(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolved = validation.resolved;

        // Check if file exists
        try {
            await fsPromises.access(resolved);
        } catch (error) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Get file extension and set appropriate content type
        const mimeType = mime.lookup(resolved) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        // Stream the file
        const fileStream = fs.createReadStream(resolved);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });

    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

router.get('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {

        // Using fsPromises from import

        // Resolve the project's absolute path through the DB (projectId is the
        // primary key of the `projects` table after the identifier migration).
        const actualPath = await projectsDb.getProjectPathById(req.params.projectId);
        if (!actualPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Check if path exists
        try {
            await fsPromises.access(actualPath);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        const files = await getFileTree(actualPath, 10, 0, true);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

export default router;
